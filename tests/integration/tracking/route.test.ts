import { pool } from '../../helpers/db';
import { BRASOV } from '../../helpers/catalog';
import { createCustomer, mockRoute, osrmResponse } from '../../helpers/customer';
import { placedOrder } from '../../helpers/restaurantOrders';
import { assignedOrder, createCourier, pickedUpOrder, setPosition } from '../../helpers/dispatch';
import { fetchedUrls, getRoute } from '../../helpers/tracking';

// M7b GET /orders/:id/route: the road for the current leg, asked once per leg by the web.
// to_restaurant starts at the courier's stored position; to_customer is restaurant → delivery point
// (cached since checkout). getRouteOrNull: null on no position, OSRM error, or no answer within 2.5 s.

const ROUTE_3001 = { distanceM: 3001, durationS: 600, polyline: 'abc' };

beforeEach(() => {
    mockRoute(3001);
});

describe('access', () => {
    it('401 without a token', async () => {
        const { orderId } = await placedOrder();
        expect((await getRoute(orderId)).status).toBe(401);
    });

    it('403 FORBIDDEN for a courier and for the restaurant owner', async () => {
        const { orderId, owner } = await placedOrder();
        const courier = await createCourier();

        for (const headers of [courier.headers, owner]) {
            const res = await getRoute(orderId, headers);
            expect(res.status).toBe(403);
            expect(res.body.error.code).toBe('FORBIDDEN');
        }
    });

    it('400 VALIDATION_ERROR for a non-numeric id', async () => {
        const customer = await createCustomer();
        const res = await getRoute('abc', customer.headers);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it("404 ORDER_NOT_FOUND for another customer's order and for an id that does not exist", async () => {
        const { orderId } = await placedOrder();
        const stranger = await createCustomer();

        for (const id of [orderId, '999999999']) {
            const res = await getRoute(id, stranger.headers);
            expect(res.status).toBe(404);
            expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
        }
    });
});

describe('legs', () => {
    it('no courier: 200 { leg: null, route: null } and OSRM is not called', async () => {
        const { orderId, customer } = await placedOrder();
        jest.mocked(fetch).mockClear();

        const res = await getRoute(orderId, customer.headers);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ leg: null, route: null });
        expect(fetchedUrls()).toEqual([]);
    });

    it("to_restaurant: OSRM is asked from the courier's CURRENT stored position to the restaurant", async () => {
        const courier = await createCourier();
        const { orderId, customer } = await assignedOrder(courier);
        // A new point, so the route cached by the accept (from the old position) cannot answer
        await setPosition(courier.id, { lat: 45.65, lng: 25.6 });
        jest.mocked(fetch).mockClear();

        const res = await getRoute(orderId, customer.headers);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ leg: 'to_restaurant', route: ROUTE_3001 });
        const urls = fetchedUrls();
        expect(urls).toHaveLength(1);
        // OSRM wants lng,lat; from the courier, to the restaurant
        expect(urls[0]).toContain(`/route/v1/driving/25.6,45.65;${BRASOV.lng},${BRASOV.lat}?`);
    });

    it('to_restaurant without a position row: route null and OSRM is not called', async () => {
        const courier = await createCourier();
        const { orderId, customer } = await assignedOrder(courier);
        await pool.query(`DELETE FROM courier_positions WHERE courier_id = $1`, [courier.id]);
        jest.mocked(fetch).mockClear();

        const res = await getRoute(orderId, customer.headers);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ leg: 'to_restaurant', route: null });
        expect(fetchedUrls()).toEqual([]);
    });

    it('to_customer: restaurant → delivery point, served from the cache the checkout filled (no OSRM call)', async () => {
        const courier = await createCourier();
        const { orderId, customer } = await pickedUpOrder(courier);
        jest.mocked(fetch).mockClear();

        const res = await getRoute(orderId, customer.headers);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ leg: 'to_customer', route: ROUTE_3001 });
        expect(fetchedUrls()).toEqual([]);
    });

    it('to_customer with an empty cache: one OSRM call restaurant → door, the second request uses the cache', async () => {
        const courier = await createCourier();
        const { orderId, customer, door } = await pickedUpOrder(courier);
        await pool.query(`DELETE FROM route_cache`);
        jest.mocked(fetch).mockClear();

        const first = await getRoute(orderId, customer.headers);
        const second = await getRoute(orderId, customer.headers);

        expect(first.body).toEqual({ leg: 'to_customer', route: ROUTE_3001 });
        expect(second.body).toEqual(first.body);
        const urls = fetchedUrls();
        expect(urls).toHaveLength(1);
        const round4 = (n: number) => Number(n.toFixed(4));
        expect(urls[0]).toContain(`/route/v1/driving/${BRASOV.lng},${BRASOV.lat};${round4(door.lng)},${round4(door.lat)}?`);
    });
});

describe('OSRM failures never fail the request', () => {
    it('OSRM answers 500: 200 with route null', async () => {
        const courier = await createCourier();
        const { orderId, customer } = await pickedUpOrder(courier);
        await pool.query(`DELETE FROM route_cache`);
        jest.mocked(fetch).mockImplementation(async () => osrmResponse({ code: 'Error' }, 500));

        const res = await getRoute(orderId, customer.headers);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ leg: 'to_customer', route: null });
    });

    it('OSRM answers after 3 s: the request gives up at 2.5 s with route null', async () => {
        const courier = await createCourier();
        const { orderId, customer } = await pickedUpOrder(courier);
        await pool.query(`DELETE FROM route_cache`);

        // A slow answer that DOES arrive (a never-resolving fetch would block routeService's
        // in-flight map and the OSRM queue for the rest of the file).
        let lateAnswer!: Promise<Response>;
        jest.mocked(fetch).mockImplementation(() => {
            lateAnswer = new Promise((resolve) =>
                setTimeout(() => resolve(osrmResponse({ code: 'Ok', routes: [{ distance: 3001, duration: 600, geometry: 'abc' }] })), 3000)
            );
            return lateAnswer;
        });

        const startedAt = Date.now();
        const res = await getRoute(orderId, customer.headers);
        const tookMs = Date.now() - startedAt;

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ leg: 'to_customer', route: null });
        expect(tookMs).toBeGreaterThanOrEqual(2400);
        expect(tookMs).toBeLessThan(3000);

        // Let the late answer finish (and write route_cache) inside THIS test, not during the next one
        await lateAnswer;
        for (let i = 0; i < 50; i++) {
            const { rows } = await pool.query(`SELECT 1 FROM route_cache`);
            if (rows.length > 0) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }, 10_000);
});
