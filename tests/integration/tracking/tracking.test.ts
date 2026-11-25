import { pool } from '../../helpers/db';
import { BRASOV } from '../../helpers/catalog';
import { createCustomer, mockRoute } from '../../helpers/customer';
import { acceptedOrder, ownerCancel, placedOrder } from '../../helpers/restaurantOrders';
import { dispatchDueOrders } from '../../../src/services/dispatchService';
import {
    acceptedDueOrder, acceptOffer, assignedOrder, createCourier, deliver, deliveryPoint, dispatchRow,
    dispatchSettings, moved, pendingOfferOf, pickedUpOrder, sendPosition, setPosition,
} from '../../helpers/dispatch';
import { getTracking } from '../../helpers/tracking';

// M7b GET /orders/:id/tracking: polled every 3 s by the order page, database only.
// The courier is shown only while one is assigned AND the order is accepted / ready_for_pickup / picked_up.

beforeEach(() => {
    mockRoute(3001);
});

describe('access', () => {
    it('401 without a token', async () => {
        const { orderId } = await placedOrder();
        const res = await getTracking(orderId);
        expect(res.status).toBe(401);
    });

    it('403 FORBIDDEN for a courier and for the restaurant owner', async () => {
        const { orderId, owner } = await placedOrder();
        const courier = await createCourier();

        for (const headers of [courier.headers, owner]) {
            const res = await getTracking(orderId, headers);
            expect(res.status).toBe(403);
            expect(res.body.error.code).toBe('FORBIDDEN');
        }
    });

    it('400 VALIDATION_ERROR for a non-numeric id', async () => {
        const customer = await createCustomer();
        const res = await getTracking('abc', customer.headers);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it("404 ORDER_NOT_FOUND for another customer's order and for an id that does not exist", async () => {
        const { orderId } = await placedOrder();
        const stranger = await createCustomer();

        for (const [id, headers] of [[orderId, stranger.headers], ['999999999', stranger.headers]] as const) {
            const res = await getTracking(id, headers);
            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
        }
    });
});

describe('before a courier is assigned', () => {
    it('placed: leg null, courier null; the restaurant and the delivery point come from the DB', async () => {
        const { orderId, customer } = await placedOrder();
        const door = await deliveryPoint(orderId);

        const res = await getTracking(orderId, customer.headers);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            orderId,
            status: 'placed',
            leg: null,
            restaurant: { name: 'Pizza Test', lat: BRASOV.lat, lng: BRASOV.lng },
            destination: { lat: door.lat, lng: door.lng },
            courier: null,
        });
    });

    it('accepted by the restaurant, no courier yet: leg null, courier null', async () => {
        const { orderId, customer } = await acceptedOrder();

        const res = await getTracking(orderId, customer.headers);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'accepted', leg: null, courier: null });
    });
});

describe('while the courier works on the order', () => {
    it('accepted with a courier: leg to_restaurant; then the owner cancels (T11): the courier is gone', async () => {
        const courier = await createCourier({ vehicle: 'scooter' });
        const { orderId, owner, customer } = await acceptedDueOrder();
        await dispatchDueOrders();
        await acceptOffer(courier, (await pendingOfferOf(courier.id))!.id);

        const during = await getTracking(orderId, customer.headers);
        expect(during.body).toMatchObject({
            status: 'accepted',
            leg: 'to_restaurant',
            courier: { firstName: 'Test', vehicleType: 'scooter' },
        });

        const cancelled = await ownerCancel(orderId, owner);
        expect(cancelled.status).toBe(200);

        const after = await getTracking(orderId, customer.headers);
        expect(after.body).toMatchObject({ status: 'cancelled', leg: null, courier: null });
    });

    it('ready_for_pickup: leg to_restaurant, and the courier has ONLY firstName, vehicleType and position', async () => {
        const courier = await createCourier({ vehicle: 'bike' });
        const { orderId, customer } = await assignedOrder(courier);

        const res = await getTracking(orderId, customer.headers);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            status: 'ready_for_pickup',
            leg: 'to_restaurant',
            courier: { firstName: 'Test', vehicleType: 'bike' }, // full_name 'Test User' → first word
        });
        // no last name, phone, email or id leaks to the customer
        expect(Object.keys(res.body.courier).sort()).toEqual(['firstName', 'isRobot', 'position', 'vehicleType']);
        expect(Object.keys(res.body.courier.position).sort()).toEqual(['ageS', 'headingDeg', 'lat', 'lng', 'stale']);
    });

    it('picked_up: leg to_customer', async () => {
        const courier = await createCourier();
        const { orderId, customer } = await pickedUpOrder(courier);

        const res = await getTracking(orderId, customer.headers);

        expect(res.body).toMatchObject({ status: 'picked_up', leg: 'to_customer', courier: { firstName: 'Test' } });
    });

    it('delivered: leg null and courier null, although orders.courier_id is still set', async () => {
        const courier = await createCourier();
        const { orderId, customer, door } = await pickedUpOrder(courier);
        await setPosition(courier.id, door);
        expect((await deliver(courier, orderId)).status).toBe(200);

        const res = await getTracking(orderId, customer.headers);

        expect(res.body).toMatchObject({ status: 'delivered', leg: null, courier: null });
        expect((await dispatchRow(orderId)).courier_id).toBe(courier.id);
    });
});

describe('the courier position', () => {
    it('no courier_positions row: position null, the courier is still shown', async () => {
        const courier = await createCourier();
        const { orderId, customer } = await assignedOrder(courier);
        await pool.query(`DELETE FROM courier_positions WHERE courier_id = $1`, [courier.id]);

        const res = await getTracking(orderId, customer.headers);

        expect(res.body.leg).toBe('to_restaurant');
        expect(res.body.courier).toEqual({ firstName: 'Test', vehicleType: 'bike', isRobot: false, position: null });
    });

    it('fresh: the stored point, ageS 0-1, stale false, headingDeg null when the phone did not send one', async () => {
        const courier = await createCourier();
        const { orderId, customer } = await assignedOrder(courier);
        const at = moved(BRASOV, 500, 200);
        await setPosition(courier.id, at);

        const res = await getTracking(orderId, customer.headers);

        const position = res.body.courier.position;
        expect(position).toMatchObject({ lat: at.lat, lng: at.lng, headingDeg: null, stale: false });
        expect(position.ageS).toBeGreaterThanOrEqual(0);
        expect(position.ageS).toBeLessThanOrEqual(1);
    });

    it('headingDeg sent by the phone comes through', async () => {
        const courier = await createCourier();
        const { orderId, customer } = await assignedOrder(courier);
        const sent = await sendPosition(courier, moved(BRASOV, 200), { headingDeg: 90 });
        expect(sent.status).toBe(204);

        const res = await getTracking(orderId, customer.headers);

        expect(res.body.courier.position).toMatchObject({ headingDeg: 90, stale: false });
    });

    it('40 s old (setting 30 s): still returned, with ageS 40 and stale true', async () => {
        const { courier_fresh_position_s: freshS } = await dispatchSettings();
        const courier = await createCourier();
        const { orderId, customer } = await assignedOrder(courier);
        const at = moved(BRASOV, 400);
        const ageS = freshS + 10;
        await setPosition(courier.id, at, ageS);

        const res = await getTracking(orderId, customer.headers);

        const position = res.body.courier.position;
        expect(position).toMatchObject({ lat: at.lat, lng: at.lng, stale: true });
        expect(position.ageS).toBeGreaterThanOrEqual(ageS);
        expect(position.ageS).toBeLessThanOrEqual(ageS + 1);
    });

    it('the boundary: 2 s younger than the setting is fresh, exactly the setting is stale', async () => {
        const { courier_fresh_position_s: freshS } = await dispatchSettings();
        const courier = await createCourier();
        const { orderId, customer } = await assignedOrder(courier);

        await setPosition(courier.id, BRASOV, freshS - 2);
        expect((await getTracking(orderId, customer.headers)).body.courier.position.stale).toBe(false);

        // received_at = now() - freshS at insert time, so by the time the SELECT runs it is at least freshS old
        await setPosition(courier.id, BRASOV, freshS);
        expect((await getTracking(orderId, customer.headers)).body.courier.position.stale).toBe(true);
    });
});
