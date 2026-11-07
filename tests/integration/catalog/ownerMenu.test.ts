import { api } from '../../helpers/http';
import { pool } from '../../helpers/db';
import { createUser } from '../../helpers/users';
import {
    bearer, createBrand, createRestaurant, createOwnerWithRestaurant, createMenuItem,
    type OwnerWithRestaurant,
} from '../../helpers/catalog';

const NO_RESTAURANT = { error: { code: 'NO_RESTAURANT', message: 'You do not own a restaurant', details: null } };
const NOT_FOUND = { error: { code: 'MENU_ITEM_NOT_FOUND', message: 'Menu item not found', details: null } };
const BRAND_NOT_EDITABLE = {
    error: { code: 'BRAND_NOT_EDITABLE', message: 'The menu of a chain is managed by an admin', details: null },
};

const pizza = { name: 'Pizza Margherita', description: 'Tomato, mozzarella', priceMinor: 1250, category: 'Pizza', sortOrder: 2 };

let ctx: OwnerWithRestaurant;
beforeEach(async () => {
    ctx = await createOwnerWithRestaurant();
});

describe('owner menu routes: authorization', () => {
    it.each([
        ['GET', '/owner/menu-items'],
        ['POST', '/owner/menu-items'],
        ['PATCH', '/owner/menu-items/1'],
        ['PUT', '/owner/menu-items/1/availability'],
    ])('%s %s answers 401 without a token', async (method, path) => {
        const res = await api()[method.toLowerCase() as 'get'](path);
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('UNAUTHENTICATED');
    });

    it.each(['customer', 'courier', 'admin'] as const)('answers 403 FORBIDDEN for a %s', async (role) => {
        const user = await createUser({ role });
        const res = await api().post('/owner/menu-items').set(bearer(user)).send(pizza);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('answers 403 NO_RESTAURANT for an owner whose restaurant is not approved yet', async () => {
        const owner = await createUser({ role: 'restaurant_owner' });
        for (const req of [
            api().get('/owner/menu-items').set(bearer(owner)),
            api().post('/owner/menu-items').set(bearer(owner)).send(pizza),
            api().put('/owner/menu-items/1/availability').set(bearer(owner)).send({ available: false }),
        ]) {
            const res = await req;
            expect(res.status).toBe(403);
            expect(res.body).toEqual(NO_RESTAURANT);
        }
    });
});

describe('POST /owner/menu-items', () => {
    it('creates an item in the owner\'s private brand, priced in euro cents', async () => {
        const res = await api().post('/owner/menu-items').set(ctx.headers).send(pizza);

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({
            brand_id: ctx.brandId, name: 'Pizza Margherita', description: 'Tomato, mozzarella',
            price_minor: 1250, currency: 'EUR', category: 'Pizza', sort_order: 2,
            image_url: null, is_active: true,
        });
        const { rows } = await pool.query('SELECT brand_id, price_minor FROM menu_items WHERE id = $1', [res.body.id]);
        expect(rows[0]).toEqual({ brand_id: ctx.brandId, price_minor: 1250 });
    });

    it('uses defaults for the optional fields', async () => {
        const res = await api().post('/owner/menu-items').set(ctx.headers).send({ name: 'Water', priceMinor: 0 });

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ description: null, category: null, sort_order: 0, image_url: null, price_minor: 0 });
    });

    it('trims the name and accepts an https image URL', async () => {
        const res = await api().post('/owner/menu-items').set(ctx.headers)
            .send({ name: '  Soup  ', priceMinor: 700, imageUrl: 'https://images.unsplash.com/photo-1' });

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ name: 'Soup', image_url: 'https://images.unsplash.com/photo-1' });
    });

    it.each([
        ['a price in euros with decimals', { priceMinor: 12.5 }, 'priceMinor'],
        ['a price as a string', { priceMinor: '1250' }, 'priceMinor'],
        ['a negative price', { priceMinor: -1 }, 'priceMinor'],
        ['a price over 1000 EUR', { priceMinor: 100_001 }, 'priceMinor'],
        ['an empty name', { name: '   ' }, 'name'],
        ['an http image URL', { imageUrl: 'http://example.com/a.jpg' }, 'imageUrl'],
        ['an unknown field', { brandId: '1' }, ''],
        ['isActive on create', { isActive: false }, ''],
    ])('rejects %s with 400', async (_case, override, field) => {
        const res = await api().post('/owner/menu-items').set(ctx.headers).send({ ...pizza, ...override });

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
    });

    it('answers 403 BRAND_NOT_EDITABLE for the owner of a chain location', async () => {
        const chain = await createBrand({ name: 'Chain', kind: 'chain', osmBrandTag: 'Chain' });
        const owner = await createUser({ role: 'restaurant_owner' });
        await createRestaurant({ brandId: chain, ownerId: owner.id });

        const res = await api().post('/owner/menu-items').set(bearer(owner)).send(pizza);

        expect(res.status).toBe(403);
        expect(res.body).toEqual(BRAND_NOT_EDITABLE);
    });
});

describe('PATCH /owner/menu-items/:id', () => {
    it('changes only the fields that were sent', async () => {
        const id = await createMenuItem(ctx.brandId, { name: 'Pizza', priceMinor: 1000, category: 'Pizza', sortOrder: 3 });

        const res = await api().patch(`/owner/menu-items/${id}`).set(ctx.headers).send({ priceMinor: 1100 });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ id, name: 'Pizza', price_minor: 1100, category: 'Pizza', sort_order: 3 });
    });

    it('soft deletes and restores an item with isActive', async () => {
        const id = await createMenuItem(ctx.brandId);

        const off = await api().patch(`/owner/menu-items/${id}`).set(ctx.headers).send({ isActive: false });
        expect(off.body.is_active).toBe(false);

        const on = await api().patch(`/owner/menu-items/${id}`).set(ctx.headers).send({ isActive: true });
        expect(on.body.is_active).toBe(true);
    });

    it('rejects an empty body with 400', async () => {
        const id = await createMenuItem(ctx.brandId);
        const res = await api().patch(`/owner/menu-items/${id}`).set(ctx.headers).send({});
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it.each(['abc', '0x1', '1.5', '1234567890123456789'])('rejects the id %s with 400', async (id) => {
        const res = await api().patch(`/owner/menu-items/${id}`).set(ctx.headers).send({ priceMinor: 1 });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid id' });
    });

    it('answers 404 for an item that does not exist', async () => {
        const res = await api().patch('/owner/menu-items/999999').set(ctx.headers).send({ priceMinor: 1 });
        expect(res.status).toBe(404);
        expect(res.body).toEqual(NOT_FOUND);
    });

    it('answers 404 for an item of another brand and leaves it unchanged', async () => {
        const other = await createOwnerWithRestaurant();
        const id = await createMenuItem(other.brandId, { priceMinor: 1000 });

        const res = await api().patch(`/owner/menu-items/${id}`).set(ctx.headers).send({ priceMinor: 1 });

        expect(res.status).toBe(404);
        expect(res.body).toEqual(NOT_FOUND);
        const { rows } = await pool.query('SELECT price_minor FROM menu_items WHERE id = $1', [id]);
        expect(rows[0].price_minor).toBe(1000);
    });

    it('answers 403 BRAND_NOT_EDITABLE for the owner of a chain location', async () => {
        const chain = await createBrand({ name: 'Chain', kind: 'chain', osmBrandTag: 'Chain' });
        const owner = await createUser({ role: 'restaurant_owner' });
        await createRestaurant({ brandId: chain, ownerId: owner.id });
        const id = await createMenuItem(chain);

        const res = await api().patch(`/owner/menu-items/${id}`).set(bearer(owner)).send({ priceMinor: 1 });

        expect(res.status).toBe(403);
        expect(res.body).toEqual(BRAND_NOT_EDITABLE);
    });
});

describe('GET /owner/menu-items', () => {
    it('lists the whole brand menu, inactive items included, ordered by category, sort_order, id', async () => {
        const noCategory = await createMenuItem(ctx.brandId, { name: 'Bread', category: null });
        const pizzaB = await createMenuItem(ctx.brandId, { name: 'Pizza B', category: 'Pizza', sortOrder: 2 });
        const pizzaA = await createMenuItem(ctx.brandId, { name: 'Pizza A', category: 'Pizza', sortOrder: 1 });
        const drink = await createMenuItem(ctx.brandId, { name: 'Cola', category: 'Drinks', isActive: false });
        await createMenuItem((await createOwnerWithRestaurant()).brandId, { name: 'Not mine' });

        const res = await api().get('/owner/menu-items').set(ctx.headers);

        expect(res.status).toBe(200);
        expect(res.body.editable).toBe(true);
        expect(res.body.items.map((i: { id: string }) => i.id)).toEqual([drink, pizzaA, pizzaB, noCategory]);
        expect(res.body.items[0]).toMatchObject({ name: 'Cola', is_active: false, available: true });
    });

    it('reports editable=false for a chain location', async () => {
        const chain = await createBrand({ name: 'Chain', kind: 'chain', osmBrandTag: 'Chain' });
        const owner = await createUser({ role: 'restaurant_owner' });
        await createRestaurant({ brandId: chain, ownerId: owner.id });
        await createMenuItem(chain);

        const res = await api().get('/owner/menu-items').set(bearer(owner));

        expect(res.status).toBe(200);
        expect(res.body.editable).toBe(false);
        expect(res.body.items).toHaveLength(1);
    });
});

describe('PUT /owner/menu-items/:id/availability', () => {
    it('stores an override and shows it in the owner menu', async () => {
        const id = await createMenuItem(ctx.brandId);

        const res = await api().put(`/owner/menu-items/${id}/availability`).set(ctx.headers).send({ available: false });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ menu_item_id: id, available: false });
        const { rows } = await pool.query(
            'SELECT restaurant_id, available, updated_by FROM restaurant_item_availability WHERE menu_item_id = $1', [id]);
        expect(rows).toEqual([{ restaurant_id: ctx.restaurantId, available: false, updated_by: ctx.owner.id }]);

        const list = await api().get('/owner/menu-items').set(ctx.headers);
        expect(list.body.items[0].available).toBe(false);
    });

    it('updates the same row when toggled again (upsert)', async () => {
        const id = await createMenuItem(ctx.brandId);
        await api().put(`/owner/menu-items/${id}/availability`).set(ctx.headers).send({ available: false });

        const res = await api().put(`/owner/menu-items/${id}/availability`).set(ctx.headers).send({ available: true });

        expect(res.body).toEqual({ menu_item_id: id, available: true });
        const { rows } = await pool.query('SELECT available FROM restaurant_item_availability WHERE menu_item_id = $1', [id]);
        expect(rows).toEqual([{ available: true }]);
    });

    it('is allowed for the owner of a chain location, for their restaurant only', async () => {
        const chain = await createBrand({ name: 'Chain', kind: 'chain', osmBrandTag: 'Chain' });
        const owner = await createUser({ role: 'restaurant_owner' });
        const mine = await createRestaurant({ brandId: chain, ownerId: owner.id });
        const sibling = await createRestaurant({ brandId: chain, ownerId: (await createUser({ role: 'restaurant_owner' })).id });
        const id = await createMenuItem(chain);

        const res = await api().put(`/owner/menu-items/${id}/availability`).set(bearer(owner)).send({ available: false });

        expect(res.status).toBe(200);
        const { rows } = await pool.query('SELECT restaurant_id FROM restaurant_item_availability WHERE menu_item_id = $1', [id]);
        expect(rows).toEqual([{ restaurant_id: mine.id }]);
        expect(rows).not.toContainEqual({ restaurant_id: sibling.id });
    });

    it('answers 404 for an item of another brand and writes nothing', async () => {
        const other = await createOwnerWithRestaurant();
        const id = await createMenuItem(other.brandId);

        const res = await api().put(`/owner/menu-items/${id}/availability`).set(ctx.headers).send({ available: false });

        expect(res.status).toBe(404);
        expect(res.body).toEqual(NOT_FOUND);
        const { rows } = await pool.query('SELECT count(*)::int AS n FROM restaurant_item_availability');
        expect(rows[0].n).toBe(0);
    });

    it.each([
        ['a missing field', {}],
        ['a string', { available: 'false' }],
        ['an extra field', { available: false, restaurantId: '1' }],
    ])('rejects %s with 400', async (_case, body) => {
        const id = await createMenuItem(ctx.brandId);
        const res = await api().put(`/owner/menu-items/${id}/availability`).set(ctx.headers).send(body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
});
