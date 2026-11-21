import { mockRoute, createShop } from '../../helpers/customer';
import { outboxRows, orderRow } from '../../helpers/payments';
import { fakeStripe } from '../../helpers/fakeStripe';
import {
    placedOrder, acceptedOrder, reject, kitchenRow, restaurantRow, setMissedOrders, historyWithReason,
} from '../../helpers/restaurantOrders';

beforeEach(() => {
    mockRoute(3001);
});

describe('T7: POST /owner/orders/:id/reject', () => {
    it('rejects: restaurant, reason, note, ended_at; queues one void; 200 with the ended order', async () => {
        const { orderId, owner, piId, shop } = await placedOrder();

        const res = await reject(orderId, owner, { reasonCode: 'out_of_stock', note: 'No more mozzarella' });

        expect(res.status).toBe(200);
        const row = await kitchenRow(orderId);
        expect(row).toMatchObject({
            status: 'rejected', cancelled_by: 'restaurant', cancel_reason: 'out_of_stock',
            cancel_note: 'No more mozzarella', ended_at: expect.any(Date),
        });
        expect(res.body).toEqual({
            id: orderId, status: 'rejected', version: row.version, cancelledBy: 'restaurant',
            cancelReason: 'out_of_stock', cancelNote: 'No more mozzarella', endedAt: row.ended_at!.toISOString(),
        });
        const voids = await outboxRows(orderId, 'payment.void');
        expect(voids).toHaveLength(1);
        expect(voids[0]).toMatchObject({ idempotency_key: `order:${orderId}:void`, payload: { paymentIntentId: piId } });
        // The void waits for the outbox runner: Stripe is not called inside the request.
        expect(fakeStripe.calls('cancel')).toHaveLength(0);
        expect(await historyWithReason(orderId)).toContainEqual({
            from_status: 'placed', to_status: 'rejected', actor: `user:${shop.owner.id}`, reason: 'rejected: out_of_stock',
        });
    });

    it('"other" with a note is accepted; the note is trimmed', async () => {
        const { orderId, owner } = await placedOrder();

        const res = await reject(orderId, owner, { reasonCode: 'other', note: '  Oven broke  ' });

        expect(res.status).toBe(200);
        expect((await kitchenRow(orderId)).cancel_note).toBe('Oven broke');
    });

    it('resets the "missed orders in a row" counter (the owner did answer)', async () => {
        const { orderId, owner, shop } = await placedOrder();
        await setMissedOrders(shop.restaurantId, 1);

        await reject(orderId, owner);

        expect((await restaurantRow(shop.restaurantId)).consecutive_timeouts).toBe(0);
    });

    it('a second reject (double click) answers 200 with the stored state; still one void', async () => {
        const { orderId, owner } = await placedOrder();
        const first = await reject(orderId, owner, { reasonCode: 'too_busy' });

        const again = await reject(orderId, owner, { reasonCode: 'closing_soon' });

        expect(again.status).toBe(200);
        expect(again.body).toEqual(first.body);
        expect((await kitchenRow(orderId)).cancel_reason).toBe('too_busy');
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(1);
    });
});

describe('T7: refusals', () => {
    it('409 ORDER_STATUS_CHANGED once accepted (after accepting, the way out is T11 cancel)', async () => {
        const { orderId, owner } = await acceptedOrder();

        const res = await reject(orderId, owner);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'ORDER_STATUS_CHANGED', details: { status: 'accepted' } });
        expect((await kitchenRow(orderId)).status).toBe('accepted');
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(0);
    });

    it.each([
        ['missing reasonCode', {}],
        ['unknown reasonCode', { reasonCode: 'kitchen_issue' }],
        ['"other" without a note', { reasonCode: 'other' }],
        ['"other" with only spaces', { reasonCode: 'other', note: '   ' }],
        ['note over 500 characters', { reasonCode: 'too_busy', note: 'x'.repeat(501) }],
    ])('400 VALIDATION_ERROR for %s; the order stays placed', async (_label, body) => {
        const { orderId, owner } = await placedOrder();

        const res = await reject(orderId, owner, body);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect((await orderRow(orderId)).status).toBe('placed');
    });

    it('"other" without a note points at the note field', async () => {
        const { orderId, owner } = await placedOrder();

        const res = await reject(orderId, owner, { reasonCode: 'other' });

        expect(res.body.error.details).toContainEqual({ field: 'note', message: 'A note is required when the reason is other' });
    });

    it('404 for another restaurant\'s order, 403 for a customer', async () => {
        const { orderId, customer } = await placedOrder();
        const otherShop = await createShop();

        expect((await reject(orderId, otherShop.headers)).status).toBe(404);
        expect((await reject(orderId, customer.headers)).status).toBe(403);
        expect((await orderRow(orderId)).status).toBe('placed');
    });
});
