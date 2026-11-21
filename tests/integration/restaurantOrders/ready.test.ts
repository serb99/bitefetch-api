import { mockRoute, createShop } from '../../helpers/customer';
import { outboxRows } from '../../helpers/payments';
import {
    placedOrder, acceptedOrder, ready, ownerCancel, kitchenRow, openKitchenLate, incidents, historyWithReason,
} from '../../helpers/restaurantOrders';

beforeEach(() => {
    mockRoute(3001);
});

describe('T10: POST /owner/orders/:id/ready', () => {
    it('accepted → ready_for_pickup: ready_at set; dispatch moved up to now; 200 with the new state', async () => {
        const { orderId, owner, shop } = await acceptedOrder(30); // dispatch_after was accepted_at + 20 min

        const res = await ready(orderId, owner);

        expect(res.status).toBe(200);
        const row = await kitchenRow(orderId);
        expect(row.status).toBe('ready_for_pickup');
        expect(row.dispatch_after!.getTime()).toBe(row.ready_at!.getTime());
        expect(res.body).toEqual({
            id: orderId, status: 'ready_for_pickup', version: row.version,
            readyAt: row.ready_at!.toISOString(), dispatchAfter: row.dispatch_after!.toISOString(),
        });
        expect(await historyWithReason(orderId)).toContainEqual({
            from_status: 'accepted', to_status: 'ready_for_pickup', actor: `user:${shop.owner.id}`, reason: 'marked ready',
        });
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(0);
    });

    it('keeps an earlier dispatch_after (dispatch already due) instead of pushing it later', async () => {
        const { orderId, owner } = await acceptedOrder(10); // dispatch_after = accepted_at
        const before = (await kitchenRow(orderId)).dispatch_after!;

        await ready(orderId, owner);

        expect((await kitchenRow(orderId)).dispatch_after).toEqual(before);
    });

    it('resolves an open kitchen_late incident', async () => {
        const { orderId, owner, shop } = await acceptedOrder();
        await openKitchenLate(orderId, shop.restaurantId);

        await ready(orderId, owner);

        expect(await incidents(shop.restaurantId)).toEqual([expect.objectContaining({
            order_id: orderId, type: 'kitchen_late', resolved_at: expect.any(Date), resolution_note: 'marked ready by the restaurant',
        })]);
    });

    it('a second ready (double click) answers 200 with the stored state and changes nothing', async () => {
        const { orderId, owner } = await acceptedOrder();
        const first = await ready(orderId, owner);

        const again = await ready(orderId, owner);

        expect(again.status).toBe(200);
        expect(again.body).toEqual(first.body);
    });
});

describe('T10: refusals', () => {
    it('409 ORDER_STATUS_CHANGED while still placed (accept first)', async () => {
        const { orderId, owner } = await placedOrder();

        const res = await ready(orderId, owner);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'ORDER_STATUS_CHANGED', details: { status: 'placed' } });
    });

    it('409 ORDER_STATUS_CHANGED after the restaurant cancelled it', async () => {
        const { orderId, owner } = await acceptedOrder();
        await ownerCancel(orderId, owner);

        const res = await ready(orderId, owner);

        expect(res.status).toBe(409);
        expect(res.body.error.details).toEqual({ status: 'cancelled' });
    });

    it('404 for another restaurant\'s order, 403 for a customer, 400 for a bad id', async () => {
        const { orderId, owner, customer } = await acceptedOrder();
        const otherShop = await createShop();

        expect((await ready(orderId, otherShop.headers)).status).toBe(404);
        expect((await ready(orderId, customer.headers)).status).toBe(403);
        expect((await ready('abc', owner)).status).toBe(400);
        expect((await kitchenRow(orderId)).status).toBe('accepted');
    });
});
