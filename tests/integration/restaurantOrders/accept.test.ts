import { mockRoute, createCustomer, createShop } from '../../helpers/customer';
import { outboxRows } from '../../helpers/payments';
import {
    placedOrder, pendingOrderAt, accept, customerCancel, kitchenRow, restaurantRow, setMissedOrders,
    passAcceptDeadline, ownerWithoutRestaurant, historyWithReason,
} from '../../helpers/restaurantOrders';

const MINUTE = 60_000;

beforeEach(() => {
    mockRoute(3001);
});

describe('T6: POST /owner/orders/:id/accept', () => {
    it('no body: accepted with the default prep (20 min); times and dispatch fields set; 200 with the new state', async () => {
        const { orderId, owner } = await placedOrder();

        const res = await accept(orderId, owner);

        expect(res.status).toBe(200);
        const row = await kitchenRow(orderId);
        expect(row).toMatchObject({ status: 'accepted', prep_minutes: 20, dispatch_state: 'not_started', version: 2 });
        // One transaction, one now(): the times are exact.
        expect(row.estimated_ready_at!.getTime() - row.accepted_at!.getTime()).toBe(20 * MINUTE);
        // dispatch_lead_s = 600: dispatch starts 10 min before the food is ready.
        expect(row.dispatch_after!.getTime() - row.accepted_at!.getTime()).toBe(10 * MINUTE);
        expect(res.body).toEqual({
            id: orderId,
            status: 'accepted',
            version: 2,
            prepMinutes: 20,
            acceptedAt: row.accepted_at!.toISOString(),
            estimatedReadyAt: row.estimated_ready_at!.toISOString(),
            dispatchAfter: row.dispatch_after!.toISOString(),
        });
    });

    it('prepMinutes 25: ready in 25 min, dispatch after 15 min', async () => {
        const { orderId, owner } = await placedOrder();

        const res = await accept(orderId, owner, { prepMinutes: 25 });

        expect(res.status).toBe(200);
        const row = await kitchenRow(orderId);
        expect(row.prep_minutes).toBe(25);
        expect(row.estimated_ready_at!.getTime() - row.accepted_at!.getTime()).toBe(25 * MINUTE);
        expect(row.dispatch_after!.getTime() - row.accepted_at!.getTime()).toBe(15 * MINUTE);
    });

    it('prepMinutes 10 (shorter than the dispatch lead): dispatch starts right away, never in the past', async () => {
        const { orderId, owner } = await placedOrder();

        await accept(orderId, owner, { prepMinutes: 10 });

        const row = await kitchenRow(orderId);
        expect(row.dispatch_after!.getTime()).toBe(row.accepted_at!.getTime());
    });

    it('writes the history row with the owner as actor and the prep time as reason; queues nothing', async () => {
        const { orderId, owner, shop } = await placedOrder();

        await accept(orderId, owner, { prepMinutes: 30 });

        expect(await historyWithReason(orderId)).toContainEqual({
            from_status: 'placed', to_status: 'accepted', actor: `user:${shop.owner.id}`, reason: 'accepted, prep 30 min',
        });
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(0);
    });

    it('a second accept (double click) answers 200 with the stored state and changes nothing', async () => {
        const { orderId, owner } = await placedOrder();
        const first = await accept(orderId, owner, { prepMinutes: 25 });

        const again = await accept(orderId, owner, { prepMinutes: 40 });

        expect(again.status).toBe(200);
        expect(again.body).toEqual(first.body);
        expect(await kitchenRow(orderId)).toMatchObject({ prep_minutes: 25, version: 2 });
    });

    it('resets the "missed orders in a row" counter', async () => {
        const { orderId, owner, shop } = await placedOrder();
        await setMissedOrders(shop.restaurantId, 1);

        await accept(orderId, owner);

        expect((await restaurantRow(shop.restaurantId)).consecutive_timeouts).toBe(0);
    });

    it('keeps the counter while the restaurant is auto-paused (only the admin lifts the pause)', async () => {
        const { orderId, owner, shop } = await placedOrder();
        const pausedUntil = new Date(Date.now() + 30 * 24 * 60 * MINUTE);
        await setMissedOrders(shop.restaurantId, 2, pausedUntil);

        await accept(orderId, owner);

        expect(await restaurantRow(shop.restaurantId)).toEqual({ consecutive_timeouts: 2, paused_until: pausedUntil });
    });
});

describe('T6: refusals', () => {
    it('409 ACCEPT_WINDOW_OVER after the deadline, even before the sweep rejected it; the order stays placed', async () => {
        const { orderId, owner } = await placedOrder();
        await passAcceptDeadline(orderId);

        const res = await accept(orderId, owner);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'ACCEPT_WINDOW_OVER', details: { status: 'placed' } });
        expect(await kitchenRow(orderId)).toMatchObject({ status: 'placed', version: 1, accepted_at: null });
    });

    it('409 ORDER_STATUS_CHANGED for an order that is not paid yet (pending_payment)', async () => {
        const shop = await createShop();
        const { orderId } = await pendingOrderAt(shop);

        const res = await accept(orderId, shop.headers);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'ORDER_STATUS_CHANGED', details: { status: 'pending_payment' } });
        expect((await kitchenRow(orderId)).status).toBe('pending_payment');
    });

    it('409 ORDER_STATUS_CHANGED once the order ended (customer cancelled first)', async () => {
        const { orderId, owner, customer } = await placedOrder();
        await customerCancel(orderId, customer);

        const res = await accept(orderId, owner);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'ORDER_STATUS_CHANGED', details: { status: 'cancelled' } });
    });

    it.each([
        ['below 10', { prepMinutes: 5 }],
        ['above 60', { prepMinutes: 65 }],
        ['not a 5-minute step', { prepMinutes: 12 }],
        ['not a number', { prepMinutes: '20' }],
    ])('400 VALIDATION_ERROR for prepMinutes %s; nothing changes', async (_label, body) => {
        const { orderId, owner } = await placedOrder();

        const res = await accept(orderId, owner, body);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect((await kitchenRow(orderId)).status).toBe('placed');
    });

    it('404 for another restaurant\'s order (no hint that it exists)', async () => {
        const { orderId } = await placedOrder();
        const otherShop = await createShop();

        const res = await accept(orderId, otherShop.headers);

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
        expect((await kitchenRow(orderId)).status).toBe('placed');
    });

    it('403 NO_RESTAURANT for an owner without a restaurant, 403 for a customer, 401 without login, 400 for a bad id', async () => {
        const { orderId, customer } = await placedOrder();

        const noRestaurant = await accept(orderId, await ownerWithoutRestaurant());
        expect(noRestaurant.status).toBe(403);
        expect(noRestaurant.body.error.code).toBe('NO_RESTAURANT');
        expect((await accept(orderId, customer.headers)).status).toBe(403);
        expect((await accept(orderId, (await createCustomer()).headers)).status).toBe(403);
        expect((await accept(orderId)).status).toBe(401);
        expect((await kitchenRow(orderId)).status).toBe('placed');
    });

    it('400 for an id that is not a number (before any SQL)', async () => {
        const { owner } = await placedOrder();

        const res = await accept('41x', owner);

        expect(res.status).toBe(400);
        expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid id' });
    });
});
