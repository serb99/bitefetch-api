import { api } from '../../helpers/http';
import { pool } from '../../helpers/db';
import { createUser } from '../../helpers/users';
import {
    BRASOV, createBrand, createRestaurant, createOwnerWithRestaurant, createMenuItem, setAvailability,
} from '../../helpers/catalog';

const KM = 0.009; // degrees of latitude, roughly one kilometre

const nearby = (query: Record<string, string | number>) => api().get('/restaurants').query(query);
const menu = (id: string) => api().get(`/restaurants/${id}/menu`);

describe('GET /restaurants (nearby)', () => {
    it('lists owned restaurants inside the radius, nearest first, with the distance in km', async () => {
        const far = await createOwnerWithRestaurant({ name: 'Far', lat: BRASOV.lat + 3 * KM });
        const near = await createOwnerWithRestaurant({ name: 'Near', lat: BRASOV.lat + 1 * KM });
        await createOwnerWithRestaurant({ name: 'Outside', lat: BRASOV.lat + 8 * KM });

        const res = await nearby({ lat: BRASOV.lat, lng: BRASOV.lng });

        expect(res.status).toBe(200);
        expect(res.body.map((r: { name: string }) => r.name)).toEqual(['Near', 'Far']);
        expect(res.body[0]).toEqual({
            id: near.restaurantId, name: 'Near', brandName: 'Near', address: 'Strada Republicii 1, Brasov',
            lat: BRASOV.lat + KM, lng: BRASOV.lng, distanceKm: 1, orderable: true,
        });
        expect(res.body[1]).toMatchObject({ id: far.restaurantId, distanceKm: 3 });
    });

    it('uses a 5 km radius by default and honours radiusKm', async () => {
        await createOwnerWithRestaurant({ name: 'At 7 km', lat: BRASOV.lat + 7 * KM });

        expect((await nearby({ lat: BRASOV.lat, lng: BRASOV.lng })).body).toEqual([]);
        const wide = await nearby({ lat: BRASOV.lat, lng: BRASOV.lng, radiusKm: 10 });
        expect(wide.body.map((r: { name: string }) => r.name)).toEqual(['At 7 km']);
    });

    it('measures east-west distance correctly (longitude degrees are shorter away from the equator)', async () => {
        // at 45.64 N one degree of longitude is about 77.9 km, so 0.05 degrees is about 3.9 km
        await createOwnerWithRestaurant({ name: 'East', lng: BRASOV.lng + 0.05 });

        const res = await nearby({ lat: BRASOV.lat, lng: BRASOV.lng, radiusKm: 4 });

        expect(res.body).toHaveLength(1);
        expect(res.body[0].distanceKm).toBeCloseTo(3.9, 1);
    });

    it('hides restaurants that nobody owns (imported from OSM but not claimed)', async () => {
        await createRestaurant({ name: 'Unclaimed', osmId: 'node/1' });

        expect((await nearby({ lat: BRASOV.lat, lng: BRASOV.lng })).body).toEqual([]);
    });

    it.each([
        ['open', {}, true],
        ['closed by the owner switch', { isOpen: false }, false],
        ['paused until later', { pausedUntil: new Date(Date.now() + 3600_000) }, false],
        ['paused until a time already passed', { pausedUntil: new Date(Date.now() - 3600_000) }, true],
        ['without hours today', { openingHours: {} }, false],
    ])('marks a restaurant that is %s as orderable=%s', async (_case, options, orderable) => {
        await createOwnerWithRestaurant(options);

        const res = await nearby({ lat: BRASOV.lat, lng: BRASOV.lng });

        expect(res.body).toHaveLength(1);
        expect(res.body[0].orderable).toBe(orderable);
    });

    it('needs no login', async () => {
        await createOwnerWithRestaurant();
        expect((await nearby({ lat: BRASOV.lat, lng: BRASOV.lng })).status).toBe(200);
    });

    it.each([
        ['no coordinates', {}],
        ['only lat', { lat: 45 }],
        ['lat out of range', { lat: 91, lng: 25 }],
        ['lng out of range', { lat: 45, lng: -181 }],
        ['a non-numeric lat', { lat: 'abc', lng: 25 }],
        ['radiusKm over 25', { lat: 45, lng: 25, radiusKm: 26 }],
        ['radiusKm zero', { lat: 45, lng: 25, radiusKm: 0 }],
    ])('rejects %s with 400', async (_case, query) => {
        const res = await nearby(query);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid query parameters' });
    });
});

describe('GET /restaurants/:id/menu', () => {
    it('returns the active items grouped by category, with availability applied', async () => {
        const { restaurantId, brandId } = await createOwnerWithRestaurant({ name: 'Casa Ana' });
        const soup = await createMenuItem(brandId, { name: 'Soup', category: 'Starters', priceMinor: 700 });
        const pizza = await createMenuItem(brandId, { name: 'Pizza', category: 'Mains', priceMinor: 1250, sortOrder: 2 });
        const pasta = await createMenuItem(brandId, { name: 'Pasta', category: 'Mains', priceMinor: 1100, sortOrder: 1 });
        const bread = await createMenuItem(brandId, { name: 'Bread', category: null, priceMinor: 200 });
        await createMenuItem(brandId, { name: 'Retired', isActive: false });
        await setAvailability(restaurantId, pizza, false);

        const res = await menu(restaurantId);

        expect(res.status).toBe(200);
        expect(res.body.restaurant).toMatchObject({ id: restaurantId, name: 'Casa Ana', brandName: 'Casa Ana', orderable: true });
        expect(res.body.categories.map((c: { name: string }) => c.name)).toEqual(['Mains', 'Starters', 'Other']);
        expect(res.body.categories[0].items).toEqual([
            { id: pasta, name: 'Pasta', description: null, priceMinor: 1100, currency: 'EUR', imageUrl: null, available: true },
            { id: pizza, name: 'Pizza', description: null, priceMinor: 1250, currency: 'EUR', imageUrl: null, available: false },
        ]);
        expect(res.body.categories[1].items.map((i: { id: string }) => i.id)).toEqual([soup]);
        expect(res.body.categories[2].items.map((i: { id: string }) => i.id)).toEqual([bread]);
    });

    it('applies the availability override per restaurant: two locations of one chain share the menu', async () => {
        const chain = await createBrand({ name: 'Chain', kind: 'chain', osmBrandTag: 'Chain' });
        const a = await createRestaurant({ brandId: chain, ownerId: (await createUser({ role: 'restaurant_owner' })).id });
        const b = await createRestaurant({ brandId: chain, ownerId: (await createUser({ role: 'restaurant_owner' })).id });
        const burger = await createMenuItem(chain, { name: 'Burger' });
        await setAvailability(a.id, burger, false);

        const menuA = await menu(a.id);
        const menuB = await menu(b.id);

        expect(menuA.body.categories[0].items[0]).toMatchObject({ id: burger, available: false });
        expect(menuB.body.categories[0].items[0]).toMatchObject({ id: burger, available: true });
    });

    it('marks a closed restaurant as not orderable but still shows its menu', async () => {
        const { restaurantId, brandId } = await createOwnerWithRestaurant({ isOpen: false });
        await createMenuItem(brandId);

        const res = await menu(restaurantId);

        expect(res.status).toBe(200);
        expect(res.body.restaurant.orderable).toBe(false);
        expect(res.body.categories).toHaveLength(1);
    });

    it('answers 404 for an unclaimed restaurant and for one that does not exist', async () => {
        const unclaimed = await createRestaurant({ osmId: 'node/2' });

        for (const id of [unclaimed.id, '999999']) {
            const res = await menu(id);
            expect(res.status).toBe(404);
            expect(res.body).toEqual({ error: { code: 'RESTAURANT_NOT_FOUND', message: 'Restaurant not found', details: null } });
        }
    });

    it('rejects a non-numeric id with 400', async () => {
        const res = await menu('abc');
        expect(res.status).toBe(400);
        expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid id' });
    });
});

describe('database rules behind the catalog', () => {
    it('defaults the currency to EUR', async () => {
        const { rows } = await pool.query(
            `SELECT table_name, column_default FROM information_schema.columns
              WHERE column_name = 'currency' AND table_name IN ('menu_items', 'orders') ORDER BY table_name`);
        expect(rows).toEqual([
            { table_name: 'menu_items', column_default: "'EUR'::bpchar" },
            { table_name: 'orders', column_default: "'EUR'::bpchar" },
        ]);
    });

    it('allows one restaurant per owner (restaurants.owner_id is unique)', async () => {
        const { owner } = await createOwnerWithRestaurant();

        await expect(createRestaurant({ ownerId: owner.id })).rejects.toMatchObject({ code: '23505' });
    });

    it('refuses an availability override for an item of another brand (trigger)', async () => {
        const { restaurantId } = await createOwnerWithRestaurant();
        const other = await createOwnerWithRestaurant();
        const item = await createMenuItem(other.brandId);

        await expect(setAvailability(restaurantId, item, false)).rejects.toMatchObject({ code: '23514' });
    });

    it('refuses an owned restaurant without opening hours', async () => {
        const owner = await createUser({ role: 'restaurant_owner' });

        await expect(createRestaurant({ ownerId: owner.id, openingHours: null }))
            .rejects.toMatchObject({ code: '23514', constraint: 'restaurants_owned_have_hours' });
        const { rows } = await pool.query('SELECT count(*)::int AS n FROM restaurants');
        expect(rows[0].n).toBe(0);
    });
});
