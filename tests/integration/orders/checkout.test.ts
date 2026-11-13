import { api } from '../../helpers/http';
import { pool } from '../../helpers/db';
import { createUser } from '../../helpers/users';
import { bearer } from '../../helpers/catalog';
import {
    mockRoute, createCustomer, addAddress, createShop, setItem, setCartAddress, getCart, checkout, readyCart, countOrders,
} from '../../helpers/customer';

// readyCart(): 2 x Pizza (800) = 1600; mockRoute(3001) → fee 190 → total 1790
const TOTAL = 1790;

beforeEach(() => {
    mockRoute(3001);
});

describe('access and input', () => {
    it('needs a login (401) and the customer role (403)', async () => {
        expect((await api().post('/orders').send({ expectedTotalMinor: 1 })).status).toBe(401);

        const owner = await createUser({ role: 'restaurant_owner' });
        const res = await api().post('/orders').set(bearer(owner)).set('Idempotency-Key', 'k').send({ expectedTotalMinor: 1 });
        expect(res.status).toBe(403);
    });

    it('needs the Idempotency-Key header (400) and an integer expectedTotalMinor (400)', async () => {
        const { customer } = await readyCart();

        const noKey = await checkout(customer, TOTAL, null);
        expect(noKey.status).toBe(400);
        expect(noKey.body.error.code).toBe('VALIDATION_ERROR');

        const tooLong = await checkout(customer, TOTAL, 'k'.repeat(101));
        expect(tooLong.status).toBe(400);

        const badTotal = await api().post('/orders').set(customer.headers).set('Idempotency-Key', 'k')
            .send({ expectedTotalMinor: 17.9 });
        expect(badTotal.status).toBe(400);
        expect(await countOrders()).toBe(0);
    });
});

describe('POST /orders: success', () => {
    it('creates a pending_payment order with snapshots and returns 201', async () => {
        const { shop, customer } = await readyCart();

        const res = await checkout(customer, TOTAL);

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            id: expect.stringMatching(/^\d+$/),
            orderCode: expect.stringMatching(/^BF-[A-HJ-NP-Z2-9]{5}$/),
            status: 'pending_payment',
            paymentStatus: 'pending',
            restaurant: { id: shop.restaurantId, name: 'Pizza Test' },
            items: [{ menuItemId: shop.pizzaId, name: 'Pizza', unitPriceMinor: 800, quantity: 2, lineTotalMinor: 1600 }],
            subtotalMinor: 1600,
            deliveryFeeMinor: 190,
            totalMinor: 1790,
            currency: 'EUR',
            deliveryDistanceM: 3001,
            deliveryAddress: { label: null, street: 'Strada Lunga 5', details: null, city: 'Brasov' },
        });
    });

    it('the payment window is 900 s (platform setting payment_window_s)', async () => {
        const { customer } = await readyCart();

        const res = await checkout(customer, TOTAL);

        const windowS = (Date.parse(res.body.paymentExpiresAt) - Date.parse(res.body.createdAt)) / 1000;
        expect(windowS).toBeCloseTo(900, 0);
    });

    it('empties the cart and forgets its restaurant, but keeps the chosen address', async () => {
        const { customer, address } = await readyCart();

        await checkout(customer, TOTAL);

        const cart = await getCart(customer);
        expect(cart.body).toMatchObject({ restaurant: null, items: [] });
        expect(cart.body.address.id).toBe(address.id);
    });

    it('writes the first status history row (trigger)', async () => {
        const { customer } = await readyCart();

        const res = await checkout(customer, TOTAL);

        const { rows } = await pool.query(
            'SELECT from_status, to_status FROM order_status_history WHERE order_id = $1', [res.body.id]);
        expect(rows).toEqual([{ from_status: null, to_status: 'pending_payment' }]);
    });
});

describe('POST /orders: idempotency', () => {
    it('the same key again returns the same order with 200, and creates nothing', async () => {
        const { customer } = await readyCart();
        const first = await checkout(customer, TOTAL, 'retry-me');

        const again = await checkout(customer, TOTAL, 'retry-me');

        expect(again.status).toBe(200);
        expect(again.body.id).toBe(first.body.id);
        expect(again.body.orderCode).toBe(first.body.orderCode);
        expect(await countOrders()).toBe(1);
    });

    it('the replay wins over the cart checks: it still answers 200 although the cart is now empty', async () => {
        const { customer } = await readyCart();
        await checkout(customer, TOTAL, 'k');

        const again = await checkout(customer, TOTAL, 'k');

        expect(again.status).toBe(200);
    });

    it('a new key after a success is a new attempt: the cart is empty, so 409 CART_EMPTY', async () => {
        const { customer } = await readyCart();
        await checkout(customer, TOTAL, 'first');

        const res = await checkout(customer, TOTAL, 'second');

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CART_EMPTY');
    });

    it('keys are per customer: two customers can use the same key', async () => {
        const one = await readyCart();
        const two = await readyCart();

        const a = await checkout(one.customer, TOTAL, 'same');
        const b = await checkout(two.customer, TOTAL, 'same');

        expect([a.status, b.status]).toEqual([201, 201]);
        expect(a.body.id).not.toBe(b.body.id);
    });

    it('a failed attempt saves nothing, so the same key works once the problem is fixed', async () => {
        const { customer } = await readyCart();

        const wrong = await checkout(customer, 1, 'k');
        expect(wrong.status).toBe(409);

        const fixed = await checkout(customer, TOTAL, 'k');
        expect(fixed.status).toBe(201);
    });

    it('two simultaneous requests with the same key: one 201, one 200, one order', async () => {
        const { customer } = await readyCart();

        const [a, b] = await Promise.all([checkout(customer, TOTAL, 'twice'), checkout(customer, TOTAL, 'twice')]);

        expect([a.status, b.status].sort()).toEqual([200, 201]);
        expect(a.body.id).toBe(b.body.id);
        expect(await countOrders()).toBe(1);
    });

    it('two simultaneous requests with different keys: one order, the other finds the cart empty', async () => {
        const { customer } = await readyCart();

        const [a, b] = await Promise.all([checkout(customer, TOTAL, 'tab-1'), checkout(customer, TOTAL, 'tab-2')]);

        expect([a.status, b.status].sort()).toEqual([201, 409]);
        const loser = a.status === 409 ? a : b;
        expect(loser.body.error.code).toBe('CART_EMPTY');
        expect(await countOrders()).toBe(1);
    });
});

describe('POST /orders: refusals (nothing is saved)', () => {
    afterEach(async () => {
        // every case in this block must leave the database without orders
        expect(await countOrders()).toBe(0);
    });

    it('PRICE_CHANGED (409) when the total is not the one the customer saw, with the real numbers', async () => {
        const { shop, customer } = await readyCart();
        await pool.query('UPDATE menu_items SET price_minor = 900 WHERE id = $1', [shop.pizzaId]);

        const res = await checkout(customer, TOTAL);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({
            code: 'PRICE_CHANGED',
            details: { subtotalMinor: 1800, deliveryFeeMinor: 190, totalMinor: 1990 },
        });
        expect((await getCart(customer)).body.items).toHaveLength(1);   // the cart is untouched
    });

    it('CART_EMPTY (409)', async () => {
        const c = await createCustomer();

        const res = await checkout(c, 0);

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CART_EMPTY');
    });

    it('CART_NO_ADDRESS (409)', async () => {
        const shop = await createShop();
        const c = await createCustomer();
        await addAddress(c);   // saved, but not chosen for the cart
        await setItem(c, shop.pizzaId, shop.restaurantId, 2);

        const res = await checkout(c, TOTAL);

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('CART_NO_ADDRESS');
    });

    it('RESTAURANT_CLOSED (409): closed by the owner, paused, or outside opening hours', async () => {
        const { shop, customer } = await readyCart();

        for (const sql of [
            'UPDATE restaurants SET is_open = false WHERE id = $1',
            `UPDATE restaurants SET is_open = true, paused_until = now() + interval '1 hour' WHERE id = $1`,
            `UPDATE restaurants SET paused_until = NULL, opening_hours = '{}'::jsonb WHERE id = $1`,
        ]) {
            await pool.query(sql, [shop.restaurantId]);
            const res = await checkout(customer, TOTAL);
            expect(res.status).toBe(409);
            expect(res.body.error.code).toBe('RESTAURANT_CLOSED');
        }
    });

    it('ITEM_UNAVAILABLE (409) lists the items that became unavailable', async () => {
        const { shop, customer } = await readyCart();
        await pool.query('UPDATE menu_items SET is_active = false WHERE id = $1', [shop.pizzaId]);

        const res = await checkout(customer, TOTAL);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({
            code: 'ITEM_UNAVAILABLE',
            details: { items: [{ menuItemId: shop.pizzaId, name: 'Pizza' }] },
        });
    });

    it('MIN_ORDER_NOT_MET (422) below 500 cents', async () => {
        const shop = await createShop({ colaPriceMinor: 300 });
        const c = await createCustomer();
        const a = await addAddress(c);
        await setItem(c, shop.colaId, shop.restaurantId, 1);
        await setCartAddress(c, a.id);

        const res = await checkout(c, 300 + 190);

        expect(res.status).toBe(422);
        expect(res.body.error).toMatchObject({
            code: 'MIN_ORDER_NOT_MET', details: { minOrderMinor: 500, subtotalMinor: 300 },
        });
    });

    it('ADDRESS_OUT_OF_RANGE (422) beyond 7000 m by road', async () => {
        mockRoute(7001);
        const { customer } = await readyCart();

        const res = await checkout(customer, 1600 + 310);

        expect(res.status).toBe(422);
        expect(res.body.error).toMatchObject({ code: 'ADDRESS_OUT_OF_RANGE', details: { maxDistanceM: 7000 } });
    });

    it('ROUTING_UNAVAILABLE (502) when OSRM cannot be reached', async () => {
        const { customer } = await readyCart();
        await pool.query('DELETE FROM route_cache');
        jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));

        const res = await checkout(customer, TOTAL);

        expect(res.status).toBe(502);
        expect(res.body.error.code).toBe('ROUTING_UNAVAILABLE');
    });
});
