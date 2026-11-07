import { api } from '../../helpers/http';
import { pool } from '../../helpers/db';
import { createUser } from '../../helpers/users';
import { bearer, createOwnerWithRestaurant, ALWAYS_OPEN, type OwnerWithRestaurant } from '../../helpers/catalog';

const NO_RESTAURANT = { error: { code: 'NO_RESTAURANT', message: 'You do not own a restaurant', details: null } };
const AUTO_PAUSED = {
    error: { code: 'RESTAURANT_AUTO_PAUSED', message: 'The restaurant was paused automatically; contact an admin', details: null },
};

const inOneHour = () => new Date(Date.now() + 60 * 60 * 1000);

let ctx: OwnerWithRestaurant;
beforeEach(async () => {
    ctx = await createOwnerWithRestaurant({ name: 'Casa Ana' });
});

const patch = (body: unknown, headers = ctx.headers) => api().patch('/owner/restaurant').set(headers).send(body as object);

describe('GET /owner/restaurant', () => {
    it('returns the owner\'s restaurant', async () => {
        const res = await api().get('/owner/restaurant').set(ctx.headers);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            id: ctx.restaurantId, brand_id: ctx.brandId, name: 'Casa Ana',
            opening_hours: ALWAYS_OPEN, is_open: true, paused_until: null, version: 0,
        });
    });

    it('answers 401 without a token and 403 for a customer', async () => {
        expect((await api().get('/owner/restaurant')).status).toBe(401);
        const customer = await createUser();
        const res = await api().get('/owner/restaurant').set(bearer(customer));
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('answers 403 NO_RESTAURANT for an owner without a restaurant', async () => {
        const owner = await createUser({ role: 'restaurant_owner' });
        const res = await api().get('/owner/restaurant').set(bearer(owner));
        expect(res.status).toBe(403);
        expect(res.body).toEqual(NO_RESTAURANT);
    });
});

describe('PATCH /owner/restaurant', () => {
    it('updates the sent fields and bumps the version', async () => {
        const hours = { mon: [['10:00', '14:00'], ['18:00', '22:00']], sat: [['12:00', '23:00']] };

        const res = await patch({ name: 'Casa Ana 2', phone: '+40 712 345 678', openingHours: hours, isOpen: false });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            name: 'Casa Ana 2', phone: '+40 712 345 678', opening_hours: hours, is_open: false, version: 1,
        });
    });

    it('lets the owner pause until a future time', async () => {
        const until = inOneHour();

        const res = await patch({ pausedUntil: until.toISOString() });

        expect(res.status).toBe(200);
        expect(new Date(res.body.paused_until).getTime()).toBe(until.getTime());
    });

    it('lets the owner end their own pause with pausedUntil: null', async () => {
        await pool.query('UPDATE restaurants SET paused_until = $1 WHERE id = $2', [inOneHour(), ctx.restaurantId]);

        const res = await patch({ pausedUntil: null });

        expect(res.status).toBe(200);
        expect(res.body.paused_until).toBeNull();
    });

    it('answers 409 RESTAURANT_AUTO_PAUSED when an auto-paused owner touches the pause', async () => {
        await pool.query(
            'UPDATE restaurants SET paused_until = $1, consecutive_timeouts = 2 WHERE id = $2',
            [inOneHour(), ctx.restaurantId]);

        const res = await patch({ pausedUntil: null });

        expect(res.status).toBe(409);
        expect(res.body).toEqual(AUTO_PAUSED);
        const { rows } = await pool.query('SELECT paused_until, version FROM restaurants WHERE id = $1', [ctx.restaurantId]);
        expect(rows[0].paused_until).not.toBeNull();
        expect(rows[0].version).toBe(0);
    });

    it('still lets an auto-paused owner change other fields', async () => {
        await pool.query(
            'UPDATE restaurants SET paused_until = $1, consecutive_timeouts = 2 WHERE id = $2',
            [inOneHour(), ctx.restaurantId]);

        const res = await patch({ name: 'Renamed' });

        expect(res.status).toBe(200);
        expect(res.body.name).toBe('Renamed');
    });

    it('answers 403 NO_RESTAURANT for an owner without a restaurant', async () => {
        const owner = await createUser({ role: 'restaurant_owner' });
        const res = await patch({ name: 'x' }, bearer(owner));
        expect(res.status).toBe(403);
        expect(res.body).toEqual(NO_RESTAURANT);
    });

    // updateRestaurantSchema exists in src/schemas/restaurantSchema.ts; these check that it is applied.
    describe('validation', () => {
        it.each([
            ['an empty body', {}],
            ['an unknown field', { ownerId: '1' }],
            ['isOpen as a string', { isOpen: 'yes' }],
            ['a pause in the past', { pausedUntil: '2020-01-01T00:00:00Z' }],
            ['a pause without a time zone', { pausedUntil: '2030-01-01T10:00:00' }],
            ['closing before opening', { openingHours: { mon: [['22:00', '10:00']] } }],
            ['overlapping ranges', { openingHours: { mon: [['10:00', '15:00'], ['14:00', '20:00']] } }],
            ['a time that is not HH:MM', { openingHours: { mon: [['9:00', '17:00']] } }],
            ['24:00', { openingHours: { mon: [['10:00', '24:00']] } }],
            ['an unknown day', { openingHours: { monday: [['10:00', '17:00']] } }],
            ['more than 3 ranges a day', { openingHours: { mon: [['01:00', '02:00'], ['03:00', '04:00'], ['05:00', '06:00'], ['07:00', '08:00']] } }],
            ['an empty name', { name: '  ' }],
        ])('rejects %s with 400 and changes nothing', async (_case, body) => {
            const res = await patch(body);

            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
            const { rows } = await pool.query('SELECT version FROM restaurants WHERE id = $1', [ctx.restaurantId]);
            expect(rows[0].version).toBe(0);
        });
    });
});
