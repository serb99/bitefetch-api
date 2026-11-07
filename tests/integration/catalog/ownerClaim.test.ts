import { api } from '../../helpers/http';
import { pool, countRows } from '../../helpers/db';
import { uniqueEmail } from '../../helpers/users';
import { createBrand, createOwnerWithRestaurant, BRASOV } from '../../helpers/catalog';
import type { OsmPlace } from '../../../src/services/osmClient';

// The OSM claim reads the chosen place from osm_search_cache (filled by GET /osm/restaurants).
// Here the cache rows are inserted directly; osmSearch.test.ts covers how they get there.

const HOURS = { mon: [['10:00', '22:00']], tue: [['10:00', '22:00']] };

function place(overrides: Partial<OsmPlace> = {}): OsmPlace {
    return {
        osmId: 'node/1001', name: 'Casa Ana', displayName: 'Casa Ana, Strada Lunga 5, Brasov, Romania',
        address: 'Strada Lunga 5, Brasov', lat: BRASOV.lat, lng: BRASOV.lng, phone: '+40 268 000 000', brand: null,
        ...overrides,
    };
}

let cacheKeys = 0;
async function cachePlaces(places: OsmPlace[], options: { kind?: 'restaurant' | 'address'; expired?: boolean } = {}) {
    cacheKeys += 1;
    await pool.query(
        `INSERT INTO osm_search_cache (query_key, query, results, expires_at)
         VALUES ($1, '{}'::jsonb, $2::jsonb, now() + $3::interval)`,
        [`${options.kind ?? 'restaurant'}|ro|test ${cacheKeys}`, JSON.stringify(places), options.expired ? '-1 minute' : '30 days'],
    );
}

function ownerBody(overrides: Record<string, unknown> = {}) {
    return {
        email: uniqueEmail('owner'), password: 'Str0ngPassw0rd', fullName: 'Ana Pop',
        openingHours: HOURS, osmId: 'node/1001',
        ...overrides,
    };
}

const signup = (body: Record<string, unknown>) => api().post('/restaurant-owners').send(body);

async function applicationOf(userId: string) {
    const { rows } = await pool.query(
        'SELECT role, status, details, restaurant_id FROM applications WHERE user_id = $1', [userId]);
    return rows[0];
}

async function restaurantRow(id: string) {
    const { rows } = await pool.query(
        `SELECT r.brand_id, r.owner_id, r.osm_id, r.name, r.address, r.lat, r.lng, r.phone, r.opening_hours,
                r.osm_synced_at IS NOT NULL AS synced, b.kind, b.name AS brand_name
           FROM restaurants r JOIN brands b ON b.id = r.brand_id WHERE r.id = $1`, [id]);
    return rows[0];
}

describe('POST /restaurant-owners with osmId (claim an OSM place)', () => {
    it('imports the place with its own private brand and files a pending application', async () => {
        await cachePlaces([place()]);

        const res = await signup(ownerBody());

        expect(res.status).toBe(201);
        const app = await applicationOf(res.body.user.id);
        expect(app).toEqual({ role: 'restaurant_owner', status: 'pending', details: { openingHours: HOURS }, restaurant_id: expect.any(String) });
        expect(await restaurantRow(app.restaurant_id)).toEqual({
            brand_id: expect.any(String), owner_id: null, osm_id: 'node/1001', name: 'Casa Ana',
            address: 'Strada Lunga 5, Brasov', lat: BRASOV.lat, lng: BRASOV.lng, phone: '+40 268 000 000',
            opening_hours: null, synced: true, kind: 'private', brand_name: 'Casa Ana',
        });
    });

    it('keeps the claimed restaurant out of browse until it is approved (owner_id stays null)', async () => {
        await cachePlaces([place()]);
        await signup(ownerBody());

        const res = await api().get('/restaurants').query(BRASOV);

        expect(res.body).toEqual([]);
    });

    it('links the place to a chain brand when its OSM brand tag matches one', async () => {
        const chain = await createBrand({ name: "McDonald's", kind: 'chain', osmBrandTag: "McDonald's" });
        await cachePlaces([place({ brand: "McDonald's", name: "McDonald's Livada" })]);

        const res = await signup(ownerBody());

        const app = await applicationOf(res.body.user.id);
        expect(await restaurantRow(app.restaurant_id)).toMatchObject({ brand_id: chain, kind: 'chain' });
        expect(await countRows('applications')).toBe(1);
        const { rows } = await pool.query('SELECT count(*)::int AS n FROM brands');
        expect(rows[0].n).toBe(1);
    });

    it('creates a private brand when the brand tag matches no chain', async () => {
        await cachePlaces([place({ brand: 'Unknown Chain' })]);

        const res = await signup(ownerBody());

        const app = await applicationOf(res.body.user.id);
        expect(await restaurantRow(app.restaurant_id)).toMatchObject({ kind: 'private', brand_name: 'Casa Ana' });
    });

    it('names the restaurant after the first part of display_name when OSM has no name, and drops a phone over 32 chars', async () => {
        await cachePlaces([place({ name: null, phone: '+40 268 000 000; +40 268 111 111; +40 7' })]);

        const res = await signup(ownerBody());

        const app = await applicationOf(res.body.user.id);
        expect(await restaurantRow(app.restaurant_id)).toMatchObject({ name: 'Casa Ana', phone: null });
    });

    it('answers 404 PLACE_NOT_FOUND and creates nothing when the place is not in the cache', async () => {
        await cachePlaces([place({ osmId: 'node/2' })]);

        const res = await signup(ownerBody());

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('PLACE_NOT_FOUND');
        expect(await countRows('users')).toBe(0);
        expect((await pool.query('SELECT 1 FROM restaurants')).rowCount).toBe(0);
    });

    it('answers 404 PLACE_NOT_FOUND when the cached search has expired', async () => {
        await cachePlaces([place()], { expired: true });

        expect((await signup(ownerBody())).status).toBe(404);
    });

    it('does not accept a place found by an address search', async () => {
        await cachePlaces([place()], { kind: 'address' });

        expect((await signup(ownerBody())).status).toBe(404);
    });

    it('answers 409 RESTAURANT_ALREADY_CLAIMED while another application for the place is pending', async () => {
        await cachePlaces([place()]);
        expect((await signup(ownerBody())).status).toBe(201);

        const res = await signup(ownerBody());

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({
            code: 'RESTAURANT_ALREADY_CLAIMED', message: 'Another owner has already applied for this restaurant',
        });
        expect(await countRows('users')).toBe(1);
        expect((await pool.query('SELECT 1 FROM restaurants')).rowCount).toBe(1);
    });

    it('lets a new owner claim the place after the first application was rejected, reusing the restaurant', async () => {
        await cachePlaces([place()]);
        const first = await signup(ownerBody());
        await pool.query(
            `UPDATE applications SET status = 'rejected', reject_reason = 'not the owner', decided_at = now()
              WHERE user_id = $1`, [first.body.user.id]);

        const second = await signup(ownerBody());

        expect(second.status).toBe(201);
        const a = await applicationOf(first.body.user.id);
        const b = await applicationOf(second.body.user.id);
        expect(b.restaurant_id).toBe(a.restaurant_id);
        expect((await pool.query('SELECT 1 FROM restaurants')).rowCount).toBe(1);
    });

    it('answers 409 RESTAURANT_ALREADY_CLAIMED when the restaurant already has an owner', async () => {
        await createOwnerWithRestaurant({ osmId: 'node/1001' });
        await cachePlaces([place()]);

        const res = await signup(ownerBody());

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'RESTAURANT_ALREADY_CLAIMED', message: 'This restaurant already has an owner' });
        expect(await countRows('applications')).toBe(0);
    });

    it('imports the place once when two owners claim it at the same moment', async () => {
        await cachePlaces([place()]);

        const answers = await Promise.all([signup(ownerBody()), signup(ownerBody())]);

        expect(answers.map((r) => r.status).sort()).toEqual([201, 409]);
        expect((await pool.query('SELECT 1 FROM restaurants')).rowCount).toBe(1);
        expect(await countRows('applications')).toBe(1);
        expect(await countRows('users')).toBe(1);
    });
});

describe('POST /restaurant-owners with manualRestaurant (not in OSM)', () => {
    const manual = { name: 'Bistro Nou', address: 'Strada Noua 3, Brasov', phone: '+40 711 111 111', lat: 45.65, lng: 25.6 };

    it('creates a private brand and a restaurant without osm_id, then a pending application', async () => {
        const res = await signup(ownerBody({ osmId: undefined, manualRestaurant: manual }));

        expect(res.status).toBe(201);
        const app = await applicationOf(res.body.user.id);
        expect(app).toMatchObject({ status: 'pending', details: { openingHours: HOURS } });
        expect(await restaurantRow(app.restaurant_id)).toEqual({
            brand_id: expect.any(String), owner_id: null, osm_id: null, name: 'Bistro Nou',
            address: 'Strada Noua 3, Brasov', lat: 45.65, lng: 25.6, phone: '+40 711 111 111',
            opening_hours: null, synced: false, kind: 'private', brand_name: 'Bistro Nou',
        });
    });

    it('rolls back the restaurant and brand when the email is taken', async () => {
        const body = ownerBody({ osmId: undefined, manualRestaurant: manual });
        expect((await signup(body)).status).toBe(201);

        const res = await signup({ ...body, email: body.email.toUpperCase() });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('EMAIL_TAKEN');
        expect((await pool.query('SELECT 1 FROM restaurants')).rowCount).toBe(1);
        expect((await pool.query('SELECT 1 FROM brands')).rowCount).toBe(1);
    });

    it.each([
        ['lat out of range', { lat: 91 }, 'manualRestaurant.lat'],
        ['lat as a string', { lat: '45.6' }, 'manualRestaurant.lat'],
        ['a missing address', { address: undefined }, 'manualRestaurant.address'],
        ['a bad phone', { phone: 'call me' }, 'manualRestaurant.phone'],
    ])('rejects %s with 400', async (_case, override, field) => {
        const res = await signup(ownerBody({ osmId: undefined, manualRestaurant: { ...manual, ...override } }));

        expect(res.status).toBe(400);
        expect(res.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
    });
});

describe('POST /restaurant-owners validation', () => {
    it.each([
        ['neither osmId nor manualRestaurant', { osmId: undefined }],
        ['both osmId and manualRestaurant', { manualRestaurant: { name: 'x', address: 'y', lat: 45, lng: 25 } }],
        ['no openingHours', { openingHours: undefined }],
        ['closing before opening', { openingHours: { mon: [['22:00', '10:00']] } }],
        ['overlapping ranges', { openingHours: { mon: [['10:00', '15:00'], ['14:00', '20:00']] } }],
        ['an unknown day', { openingHours: { monday: [['10:00', '15:00']] } }],
        ['the old restaurantName field shape', { osmId: undefined, restaurantName: 'Casa', restaurantAddress: 'Brasov' }],
    ])('rejects %s with 400 and creates nothing', async (_case, override) => {
        await cachePlaces([place()]);

        const res = await signup(ownerBody(override));

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(await countRows('users')).toBe(0);
    });

    it('accepts empty opening hours ({}): the owner can fill them in later', async () => {
        await cachePlaces([place()]);
        expect((await signup(ownerBody({ openingHours: {} }))).status).toBe(201);
    });
});
