import { api } from '../../helpers/http';
import { pool } from '../../helpers/db';
import { createUser } from '../../helpers/users';
import { bearer } from '../../helpers/catalog';
import {
    mockRoute, setItem, checkout, readyCart, type Customer,
} from '../../helpers/customer';

const TOTAL = 1790;   // 2 x 800 + fee 190 (3001 m)

beforeEach(() => {
    mockRoute(3001);
});

const listOrders = (c: Customer, query: Record<string, string | number> = {}) =>
    api().get('/orders').query(query).set(c.headers);
const getOrder = (c: Customer, id: string) => api().get(`/orders/${id}`).set(c.headers);

// Places `count` orders for the same customer (refilling the cart each time); returns their ids, oldest first.
async function placeOrders(count: number) {
    const { shop, customer } = await readyCart();
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
        if (i > 0) await setItem(customer, shop.pizzaId, shop.restaurantId, 2);
        const res = await checkout(customer, TOTAL, `key-${i}`);
        if (res.status !== 201) throw new Error(`checkout ${i} failed: ${res.status} ${JSON.stringify(res.body)}`);
        ids.push(res.body.id);
    }
    return { shop, customer, ids };
}

describe('access', () => {
    it('needs a login (401) and the customer role (403)', async () => {
        expect((await api().get('/orders')).status).toBe(401);
        const admin = await createUser({ role: 'admin' });
        expect((await api().get('/orders').set(bearer(admin))).status).toBe(403);
    });
});

describe('GET /orders', () => {
    it('lists my orders, newest first, as summaries', async () => {
        const { customer, ids } = await placeOrders(2);

        const res = await listOrders(customer);

        expect(res.status).toBe(200);
        expect(res.body.map((o: { id: string }) => o.id)).toEqual([ids[1], ids[0]]);
        expect(res.body[0]).toEqual({
            id: ids[1], orderCode: expect.stringMatching(/^BF-/), status: 'pending_payment', totalMinor: TOTAL,
            currency: 'EUR', createdAt: expect.any(String), restaurantName: 'Pizza Test', itemCount: 1,
        });
    });

    it('itemCount counts the different products, not the quantities', async () => {
        const { shop, customer } = await readyCart();   // 2 x Pizza
        await setItem(customer, shop.colaId, shop.restaurantId, 3);
        await checkout(customer, 1600 + 900 + 190);

        const res = await listOrders(customer);

        expect(res.body[0].itemCount).toBe(2);
    });

    it('never shows another customer\'s orders', async () => {
        await placeOrders(1);
        const { customer: other } = await readyCart();

        expect((await listOrders(other)).body).toEqual([]);
    });

    it('pages with limit and before=<id of the last order seen>', async () => {
        const { customer, ids } = await placeOrders(5);   // ids oldest → newest

        const page1 = await listOrders(customer, { limit: 2 });
        expect(page1.body.map((o: { id: string }) => o.id)).toEqual([ids[4], ids[3]]);

        const page2 = await listOrders(customer, { limit: 2, before: ids[3] });
        expect(page2.body.map((o: { id: string }) => o.id)).toEqual([ids[2], ids[1]]);

        const page3 = await listOrders(customer, { limit: 2, before: ids[1] });
        expect(page3.body.map((o: { id: string }) => o.id)).toEqual([ids[0]]);   // shorter page: the end
    });

    it('rejects limit outside 1..50 and a non-numeric before (400)', async () => {
        const { customer } = await readyCart();

        const queries: Record<string, string | number>[] = [{ limit: 0 }, { limit: 51 }, { before: 'abc' }];
        for (const query of queries) {
            const res = await listOrders(customer, query);
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
    });
});

describe('GET /orders/:id', () => {
    it('returns the full order', async () => {
        const { customer, ids } = await placeOrders(1);

        const res = await getOrder(customer, ids[0]);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ id: ids[0], status: 'pending_payment', totalMinor: TOTAL, items: [{ quantity: 2 }] });
    });

    it('another customer\'s order is 404 ORDER_NOT_FOUND (not 403: its existence is not revealed)', async () => {
        const { ids } = await placeOrders(1);
        const { customer: other } = await readyCart();

        const res = await getOrder(other, ids[0]);

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    });

    it('400 for an id that is not a number', async () => {
        const { customer } = await readyCart();
        expect((await getOrder(customer, 'abc')).status).toBe(400);
    });

    it('shows the snapshot: renaming or repricing the item and deleting the address change nothing', async () => {
        const { shop, customer, ids } = await placeOrders(1);
        const address = await pool.query('SELECT delivery_address_id AS id FROM orders WHERE id = $1', [ids[0]]);

        await pool.query(`UPDATE menu_items SET name = 'Renamed', price_minor = 999 WHERE id = $1`, [shop.pizzaId]);
        await api().delete(`/addresses/${address.rows[0].id}`).set(customer.headers);

        const res = await getOrder(customer, ids[0]);

        expect(res.body.items[0]).toMatchObject({ name: 'Pizza', unitPriceMinor: 800, lineTotalMinor: 1600 });
        expect(res.body.deliveryAddress).toMatchObject({ street: 'Strada Lunga 5', city: 'Brasov' });
    });

    it('keeps the line with menuItemId null when the menu item is deleted', async () => {
        const { shop, customer, ids } = await placeOrders(1);

        await pool.query('DELETE FROM menu_items WHERE id = $1', [shop.pizzaId]);

        const res = await getOrder(customer, ids[0]);
        expect(res.body.items[0]).toMatchObject({ menuItemId: null, name: 'Pizza', quantity: 2 });
    });
});
