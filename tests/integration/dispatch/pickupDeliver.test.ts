import { pool } from '../../helpers/db';
import { BRASOV } from '../../helpers/catalog';
import { mockRoute } from '../../helpers/customer';
import { outboxRows } from '../../helpers/payments';
import { fakeStripe } from '../../helpers/fakeStripe';
import { incidents, openKitchenLate, ownerCancel } from '../../helpers/restaurantOrders';
import { dispatchDueOrders } from '../../../src/services/dispatchService';
import { processPaymentOutbox } from '../../../src/services/paymentOutbox';
import {
    createCourier, moved, dispatchSettings, readyOrder, acceptedDueOrder, assignedOrder, pickedUpOrder, dispatchRow,
    pendingOfferOf, acceptOffer, currentOrder, pickup, deliver, setPosition,
} from '../../helpers/dispatch';

// M7 T12 (pickup) and T13 (delivered → capture). Both check the STORED position: fresh and within
// location_check_radius_m of the restaurant (T12) or of the delivery address (T13).

beforeEach(() => {
    mockRoute(3001);
});

const seconds = (a: Date, b: Date) => (a.getTime() - b.getTime()) / 1000;

describe('GET /courier/orders/current', () => {
    it('null without an order; the assigned order with the address but no phone; gone after delivery', async () => {
        const courier = await createCourier();
        expect((await currentOrder(courier)).body).toEqual({ order: null });

        const { orderId, door } = await pickedUpOrder(courier);
        const res = await currentOrder(courier);
        expect(res.status).toBe(200);
        expect(res.body.order).toMatchObject({
            id: orderId,
            status: 'picked_up',
            restaurant: { name: 'Pizza Test', lat: BRASOV.lat, lng: BRASOV.lng },
            customer: { firstName: 'Test', street: 'Strada Lunga 5', city: 'Brasov', lat: door.lat, lng: door.lng },
            items: [{ name: 'Pizza', quantity: 2 }],
        });
        expect(res.body.order.customer).not.toHaveProperty('phone');

        await setPosition(courier.id, door);
        await deliver(courier, orderId);
        expect((await currentOrder(courier)).body).toEqual({ order: null });
    });
});

describe('POST /courier/orders/:id/pickup (T12)', () => {
    it('from ready_for_pickup, at the restaurant: picked_up with an ETA and the route to the customer', async () => {
        const courier = await createCourier();
        const { orderId } = await assignedOrder(courier);
        await setPosition(courier.id, BRASOV);
        const before = await dispatchRow(orderId);

        const res = await pickup(courier, orderId);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ id: orderId, status: 'picked_up', version: before.version + 1, route: { polyline: 'abc' } });
        const row = await dispatchRow(orderId);
        expect(row.status).toBe('picked_up');
        expect(row.picked_up_at).not.toBeNull();
        expect(row.ready_at).toEqual(before.ready_at); // already set by T10, kept
    });

    it('from accepted (the food is handed over before "ready" was pressed): ready_at is set too', async () => {
        const courier = await createCourier();
        const { orderId } = await acceptedDueOrder();
        await dispatchDueOrders();
        await acceptOffer(courier, (await pendingOfferOf(courier.id))!.id);
        await setPosition(courier.id, BRASOV);

        const res = await pickup(courier, orderId);

        expect(res.status).toBe(200);
        const row = await dispatchRow(orderId);
        expect(row.status).toBe('picked_up');
        expect(row.ready_at).toEqual(row.picked_up_at);
    });

    it.each([
        ['bike', 1.5],
        ['scooter', 1.2],
        ['car', 1.0],
    ] as const)('ETA for a %s: the OSRM car duration (600 s) x %d', async (vehicle, factor) => {
        const courier = await createCourier({ vehicle });
        const { orderId } = await assignedOrder(courier);
        await setPosition(courier.id, BRASOV);

        await pickup(courier, orderId);

        const row = await dispatchRow(orderId);
        expect(seconds(row.estimated_delivery_at!, row.picked_up_at!)).toBe(Math.round(600 * factor));
    });

    it('OSRM down and no cached route: pickup still works, ETA from 25 km/h over the road distance', async () => {
        const courier = await createCourier({ vehicle: 'bike' });
        const { orderId } = await assignedOrder(courier);
        await setPosition(courier.id, BRASOV);
        await pool.query(`DELETE FROM route_cache`);
        jest.mocked(fetch).mockImplementation(async () => {
            throw new TypeError('fetch failed');
        });

        const res = await pickup(courier, orderId);

        expect(res.status).toBe(200);
        expect(res.body.route).toBeNull();
        const row = await dispatchRow(orderId);
        expect(seconds(row.estimated_delivery_at!, row.picked_up_at!)).toBe(Math.round((3001 / (25_000 / 3600)) * 1.5));
    });

    it('proximity: 10 m inside the radius → 200, 10 m outside → 409 TOO_FAR_AWAY (the stored position decides)', async () => {
        const { location_check_radius_m: radiusM } = await dispatchSettings();
        const courier = await createCourier();
        const { orderId } = await assignedOrder(courier);

        await setPosition(courier.id, moved(BRASOV, radiusM + 10));
        const far = await pickup(courier, orderId);
        expect(far.status).toBe(409);
        expect(far.body.error).toMatchObject({ code: 'TOO_FAR_AWAY', details: { distanceM: radiusM + 10, maxDistanceM: radiusM } });
        expect((await dispatchRow(orderId)).status).toBe('ready_for_pickup');

        await setPosition(courier.id, moved(BRASOV, radiusM - 10));
        expect((await pickup(courier, orderId)).status).toBe(200);
    });

    it('409 POSITION_STALE when the last position is too old, even if it was at the restaurant', async () => {
        const { courier_fresh_position_s: freshS } = await dispatchSettings();
        const courier = await createCourier();
        const { orderId } = await assignedOrder(courier);
        await setPosition(courier.id, BRASOV, freshS + 5);

        const res = await pickup(courier, orderId);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'POSITION_STALE', details: { maxAgeS: freshS } });
    });

    it('a pending cancel request becomes superseded, an open kitchen_late incident is resolved', async () => {
        const courier = await createCourier();
        const { orderId, shop } = await assignedOrder(courier);
        await pool.query(
            `INSERT INTO order_cancel_requests (order_id, requested_by, reason_code) VALUES ($1, $2, 'kitchen_issue')`,
            [orderId, shop.owner.id]
        );
        await openKitchenLate(orderId, shop.restaurantId);
        await setPosition(courier.id, BRASOV);

        await pickup(courier, orderId);

        const { rows } = await pool.query(`SELECT status, decided_at FROM order_cancel_requests WHERE order_id = $1`, [orderId]);
        expect(rows[0].status).toBe('superseded');
        expect(rows[0].decided_at).not.toBeNull();
        const [late] = (await incidents(shop.restaurantId)).filter((i) => i.type === 'kitchen_late');
        expect(late.resolved_at).not.toBeNull();
    });

    it('double tap: 200 with the stored state, nothing changes', async () => {
        const courier = await createCourier();
        const { orderId } = await pickedUpOrder(courier);
        const before = await dispatchRow(orderId);

        const res = await pickup(courier, orderId);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ id: orderId, status: 'picked_up', version: before.version });
        expect(await dispatchRow(orderId)).toEqual({ ...before, db_now: expect.any(Date) });
    });
});

describe('POST /courier/orders/:id/deliver (T13)', () => {
    it('at the door: delivered, one capture in the outbox; the runner captures with key :capture:1', async () => {
        const courier = await createCourier();
        const { orderId, door, piId } = await pickedUpOrder(courier);
        await setPosition(courier.id, door);
        const before = await dispatchRow(orderId);

        const res = await deliver(courier, orderId);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ id: orderId, status: 'delivered', version: before.version + 1 });
        const row = await dispatchRow(orderId);
        expect(row.status).toBe('delivered');
        expect(row.delivered_at).not.toBeNull();
        expect(row.ended_at).toEqual(row.delivered_at);
        const captures = await outboxRows(orderId, 'payment.capture');
        expect(captures).toHaveLength(1);
        expect(captures[0]).toMatchObject({ idempotency_key: `order:${orderId}:capture`, payload: { paymentIntentId: piId } });

        await processPaymentOutbox();

        expect(fakeStripe.calls('capture')).toEqual([{ method: 'capture', id: piId, idempotencyKey: `order:${orderId}:capture:1` }]);
        expect((await dispatchRow(orderId)).payment_status).toBe('captured');
    });

    it('double tap: 200 twice, still one outbox row and one capture', async () => {
        const courier = await createCourier();
        const { orderId, door } = await pickedUpOrder(courier);
        await setPosition(courier.id, door);

        expect((await deliver(courier, orderId)).status).toBe(200);
        const again = await deliver(courier, orderId);
        await processPaymentOutbox();

        expect(again.status).toBe(200);
        expect(again.body.status).toBe('delivered');
        expect(await outboxRows(orderId, 'payment.capture')).toHaveLength(1);
        expect(fakeStripe.calls('capture')).toHaveLength(1);
    });

    it('409 ORDER_STATUS_CHANGED before pickup', async () => {
        const courier = await createCourier();
        const { orderId } = await assignedOrder(courier);
        await setPosition(courier.id, BRASOV);

        const res = await deliver(courier, orderId);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'ORDER_STATUS_CHANGED', details: { status: 'ready_for_pickup' } });
    });

    it('proximity to the delivery address, not the restaurant: 409 TOO_FAR_AWAY at the restaurant', async () => {
        const { location_check_radius_m: radiusM } = await dispatchSettings();
        const courier = await createCourier();
        const { orderId, door } = await pickedUpOrder(courier); // the courier is still at the restaurant

        const atRestaurant = await deliver(courier, orderId);
        expect(atRestaurant.status).toBe(409);
        expect(atRestaurant.body.error.code).toBe('TOO_FAR_AWAY');

        await setPosition(courier.id, moved(door, 0, radiusM - 10));
        expect((await deliver(courier, orderId)).status).toBe(200);
    });

    it('409 POSITION_STALE with an old position at the door', async () => {
        const { courier_fresh_position_s: freshS } = await dispatchSettings();
        const courier = await createCourier();
        const { orderId, door } = await pickedUpOrder(courier);
        await setPosition(courier.id, door, freshS + 5);

        const res = await deliver(courier, orderId);

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('POSITION_STALE');
        expect((await dispatchRow(orderId)).status).toBe('picked_up');
    });

    it('resolves open delivery_overdue incidents', async () => {
        const courier = await createCourier();
        const { orderId, door, shop } = await pickedUpOrder(courier);
        await pool.query(
            `INSERT INTO order_incidents (order_id, restaurant_id, type, opened_by) VALUES ($1, $2, 'delivery_overdue', 'system')`,
            [orderId, shop.restaurantId]
        );
        await setPosition(courier.id, door);

        await deliver(courier, orderId);

        const [overdue] = (await incidents(shop.restaurantId)).filter((i) => i.type === 'delivery_overdue');
        expect(overdue.resolved_at).not.toBeNull();
        expect(overdue.resolution_note).toBe('delivered');
    });
});

describe('who may confirm (decision I)', () => {
    it('a courier who lost the order (the restaurant cancelled after the accept): 409 ORDER_STATUS_CHANGED', async () => {
        const courier = await createCourier();
        const { orderId, owner } = await acceptedDueOrder();
        await dispatchDueOrders();
        await acceptOffer(courier, (await pendingOfferOf(courier.id))!.id);
        expect((await ownerCancel(orderId, owner)).status).toBe(200);
        await setPosition(courier.id, BRASOV);

        const res = await pickup(courier, orderId);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'ORDER_STATUS_CHANGED', details: { status: 'cancelled' } });
        expect((await currentOrder(courier)).body).toEqual({ order: null });
    });

    it('a courier who never had the order: 404 ORDER_NOT_FOUND for pickup and deliver', async () => {
        const courier = await createCourier();
        const { orderId } = await assignedOrder(courier);
        const stranger = await createCourier({ at: BRASOV });

        for (const res of [await pickup(stranger, orderId), await deliver(stranger, orderId)]) {
            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
        }
    });
});

