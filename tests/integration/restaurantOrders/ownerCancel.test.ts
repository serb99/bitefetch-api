import { mockRoute, createShop } from '../../helpers/customer';
import { outboxRows } from '../../helpers/payments';
import {
    placedOrder, acceptedOrder, ownerCancel, ready, kitchenRow, openKitchenLate, incidents,
    pendingOffer, offerRow, historyWithReason,
} from '../../helpers/restaurantOrders';

beforeEach(() => {
    mockRoute(3001);
});

describe('T11: POST /owner/orders/:id/cancel (owner cancels until the food is ready)', () => {
    it('accepted → cancelled: restaurant, reason, note, ended_at; one void queued; 200 with the ended order', async () => {
        const { orderId, owner, piId, shop } = await acceptedOrder();

        const res = await ownerCancel(orderId, owner, { reasonCode: 'kitchen_issue', note: 'Gas cut' });

        expect(res.status).toBe(200);
        const row = await kitchenRow(orderId);
        expect(row).toMatchObject({
            status: 'cancelled', cancelled_by: 'restaurant', cancel_reason: 'kitchen_issue', cancel_note: 'Gas cut',
            ended_at: expect.any(Date), courier_id: null,
        });
        expect(res.body).toEqual({
            id: orderId, status: 'cancelled', version: row.version, cancelledBy: 'restaurant',
            cancelReason: 'kitchen_issue', cancelNote: 'Gas cut', endedAt: row.ended_at!.toISOString(),
        });
        const voids = await outboxRows(orderId, 'payment.void');
        expect(voids).toHaveLength(1);
        expect(voids[0]).toMatchObject({ idempotency_key: `order:${orderId}:void`, payload: { paymentIntentId: piId } });
        expect(await historyWithReason(orderId)).toContainEqual({
            from_status: 'accepted', to_status: 'cancelled', actor: `user:${shop.owner.id}`,
            reason: 'cancelled by the restaurant: kitchen_issue',
        });
    });

    it('withdraws a courier offer that is still pending', async () => {
        const { orderId, owner } = await acceptedOrder();
        const offerId = await pendingOffer(orderId);

        await ownerCancel(orderId, owner);

        expect(await offerRow(offerId)).toEqual({ status: 'withdrawn', responded_at: expect.any(Date) });
    });

    it('resolves an open kitchen_late incident', async () => {
        const { orderId, owner, shop } = await acceptedOrder();
        await openKitchenLate(orderId, shop.restaurantId);

        await ownerCancel(orderId, owner);

        expect(await incidents(shop.restaurantId)).toEqual([expect.objectContaining({
            type: 'kitchen_late', resolved_at: expect.any(Date), resolution_note: 'order cancelled by the restaurant',
        })]);
    });

    it('a second cancel (double click) answers 200 with the stored state; still one void', async () => {
        const { orderId, owner } = await acceptedOrder();
        const first = await ownerCancel(orderId, owner, { reasonCode: 'too_busy' });

        const again = await ownerCancel(orderId, owner, { reasonCode: 'out_of_stock' });

        expect(again.status).toBe(200);
        expect(again.body).toEqual(first.body);
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(1);
    });
});

describe('T11: refusals', () => {
    it('409 while placed: before accepting, the owner rejects (T7) instead', async () => {
        const { orderId, owner } = await placedOrder();

        const res = await ownerCancel(orderId, owner);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'ORDER_STATUS_CHANGED', details: { status: 'placed' } });
        expect((await kitchenRow(orderId)).status).toBe('placed');
    });

    it('409 once ready_for_pickup: from there only an admin-approved request (T14) can cancel', async () => {
        const { orderId, owner } = await acceptedOrder();
        await ready(orderId, owner);

        const res = await ownerCancel(orderId, owner);

        expect(res.status).toBe(409);
        expect(res.body.error.details).toEqual({ status: 'ready_for_pickup' });
        expect((await kitchenRow(orderId)).status).toBe('ready_for_pickup');
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(0);
    });

    it.each([
        ['missing reasonCode', {}],
        ['a reject-only reason (closing_soon)', { reasonCode: 'closing_soon' }],
        ['"other" without a note', { reasonCode: 'other' }],
    ])('400 VALIDATION_ERROR for %s', async (_label, body) => {
        const { orderId, owner } = await acceptedOrder();

        const res = await ownerCancel(orderId, owner, body);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect((await kitchenRow(orderId)).status).toBe('accepted');
    });

    it('404 for another restaurant\'s order, 403 for a customer', async () => {
        const { orderId, customer } = await acceptedOrder();
        const otherShop = await createShop();

        expect((await ownerCancel(orderId, otherShop.headers)).status).toBe(404);
        expect((await ownerCancel(orderId, customer.headers)).status).toBe(403);
        expect((await kitchenRow(orderId)).status).toBe('accepted');
    });
});
