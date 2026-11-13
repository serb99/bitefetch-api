import { api } from '../../helpers/http';
import { pool } from '../../helpers/db';
import { createUser } from '../../helpers/users';
import { bearer } from '../../helpers/catalog';
import {
    createCustomer, addAddress, createShop, setItem, setCartAddress, getCart, mockRoute, type Customer,
} from '../../helpers/customer';

const list = (c: Customer) => api().get('/addresses').set(c.headers);
const remove = (c: Customer, id: string) => api().delete(`/addresses/${id}`).set(c.headers);
const makeDefault = (c: Customer, id: string) => api().put(`/addresses/${id}/default`).set(c.headers);

// Addresses created in the same millisecond would tie on created_at; a small gap keeps "newest" well defined.
const pause = () => new Promise((resolve) => setTimeout(resolve, 5));

async function defaults(userId: string): Promise<string[]> {
    const { rows } = await pool.query(
        `SELECT id FROM delivery_addresses WHERE user_id = $1 AND is_default ORDER BY id`, [userId]);
    return rows.map((r) => r.id);
}

describe('access', () => {
    it('needs a login (401) and the customer role (403)', async () => {
        expect((await api().get('/addresses')).status).toBe(401);

        const owner = await createUser({ role: 'restaurant_owner' });
        const res = await api().get('/addresses').set(bearer(owner));
        expect(res.status).toBe(403);
    });
});

describe('POST /addresses', () => {
    it('creates the address; the first one becomes the default, the next ones do not', async () => {
        const c = await createCustomer();

        const res = await api().post('/addresses').set(c.headers).send({
            label: 'Home', street: 'Strada Lunga 5', details: 'ap. 3', city: 'Brasov', lat: 45.65, lng: 25.59,
        });
        expect(res.status).toBe(201);
        expect(res.body).toEqual({
            id: expect.stringMatching(/^\d+$/), label: 'Home', street: 'Strada Lunga 5', details: 'ap. 3',
            city: 'Brasov', lat: 45.65, lng: 25.59, isDefault: true,
        });

        const second = await addAddress(c);
        expect(second.isDefault).toBe(false);
    });

    it('rejects a missing street, an empty label, out-of-range coordinates and unknown fields (400)', async () => {
        const c = await createCustomer();
        const valid = { street: 'Strada Lunga 5', city: 'Brasov', lat: 45.65, lng: 25.59 };

        for (const body of [
            { ...valid, street: undefined },
            { ...valid, label: '' },
            { ...valid, lat: 91 },
            { ...valid, isDefault: true },
        ]) {
            const res = await api().post('/addresses').set(c.headers).send(body);
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
    });

    it('allows at most 10 addresses (409 ADDRESS_LIMIT)', async () => {
        const c = await createCustomer();
        for (let i = 0; i < 10; i++) await addAddress(c);

        const res = await api().post('/addresses').set(c.headers)
            .send({ street: 'Strada 11', city: 'Brasov', lat: 45.65, lng: 25.59 });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('ADDRESS_LIMIT');
    });
});

describe('GET /addresses', () => {
    it('lists only my addresses, the default first, then the newest', async () => {
        const c = await createCustomer();
        const first = await addAddress(c, { label: 'First' });
        await pause();
        await addAddress(c, { label: 'Second' });
        await pause();
        await addAddress(c, { label: 'Third' });
        await addAddress(await createCustomer(), { label: 'Someone else' });

        const res = await list(c);

        expect(res.status).toBe(200);
        expect(res.body.map((a: { label: string }) => a.label)).toEqual(['First', 'Third', 'Second']);
        expect(res.body[0]).toMatchObject({ id: first.id, isDefault: true });
    });
});

describe('PATCH /addresses/:id', () => {
    it('changes only the fields sent', async () => {
        const c = await createCustomer();
        const a = await addAddress(c, { label: 'Home', city: 'Brasov' });

        const res = await api().patch(`/addresses/${a.id}`).set(c.headers).send({ label: 'Work' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ id: a.id, label: 'Work', city: 'Brasov' });
    });

    it('rejects an empty body (400) and another customer\'s address (404)', async () => {
        const c = await createCustomer();
        const other = await addAddress(await createCustomer());
        const mine = await addAddress(c);

        const empty = await api().patch(`/addresses/${mine.id}`).set(c.headers).send({});
        expect(empty.status).toBe(400);

        const foreign = await api().patch(`/addresses/${other.id}`).set(c.headers).send({ label: 'Mine now' });
        expect(foreign.status).toBe(404);
        expect(foreign.body.error.code).toBe('ADDRESS_NOT_FOUND');
    });
});

describe('PUT /addresses/:id/default', () => {
    it('moves the default; there is always exactly one', async () => {
        const c = await createCustomer();
        const first = await addAddress(c);
        const second = await addAddress(c);

        const res = await makeDefault(c, second.id);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ id: second.id, isDefault: true });
        expect(await defaults(c.user.id)).toEqual([second.id]);
        expect(first.id).not.toBe(second.id);
    });

    it('404 for another customer\'s address, and the current default is kept', async () => {
        const c = await createCustomer();
        const mine = await addAddress(c);
        const other = await addAddress(await createCustomer());

        const res = await makeDefault(c, other.id);

        expect(res.status).toBe(404);
        expect(await defaults(c.user.id)).toEqual([mine.id]);
    });
});

describe('DELETE /addresses/:id', () => {
    it('deleting the default makes the newest remaining address the default', async () => {
        const c = await createCustomer();
        const home = await addAddress(c, { label: 'Home' });
        await pause();
        const older = await addAddress(c, { label: 'Older' });
        await pause();
        const newest = await addAddress(c, { label: 'Newest' });

        const res = await remove(c, home.id);

        expect(res.status).toBe(204);
        expect(await defaults(c.user.id)).toEqual([newest.id]);
        expect(older.id).not.toBe(newest.id);
    });

    it('deleting another address keeps the default where it is', async () => {
        const c = await createCustomer();
        const home = await addAddress(c);
        const work = await addAddress(c);

        await remove(c, work.id);

        expect(await defaults(c.user.id)).toEqual([home.id]);
    });

    it('deleting the last address leaves no addresses and no error', async () => {
        const c = await createCustomer();
        const only = await addAddress(c);

        expect((await remove(c, only.id)).status).toBe(204);
        expect((await list(c)).body).toEqual([]);
    });

    it('404 for another customer\'s address, which stays', async () => {
        const c = await createCustomer();
        const other = await addAddress(await createCustomer());

        const res = await remove(c, other.id);

        expect(res.status).toBe(404);
        const { rows } = await pool.query('SELECT 1 FROM delivery_addresses WHERE id = $1', [other.id]);
        expect(rows).toHaveLength(1);
    });

    it('the cart forgets a deleted address (ON DELETE SET NULL)', async () => {
        mockRoute(1000);
        const shop = await createShop();
        const c = await createCustomer();
        const a = await addAddress(c);
        await setItem(c, shop.pizzaId, shop.restaurantId, 1);
        await setCartAddress(c, a.id);

        await remove(c, a.id);

        const cart = await getCart(c);
        expect(cart.body.address).toBeNull();
        expect(cart.body.delivery).toBeNull();
        expect(cart.body.items).toHaveLength(1);
    });
});
