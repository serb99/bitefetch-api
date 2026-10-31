import bcrypt from 'bcrypt';
import { api, lastActivationToken, printedActivationTokens } from '../../helpers/http';
import { pool, countRows } from '../../helpers/db';
import { createUser } from '../../helpers/users';
import { hashToken } from '../../../src/utils/tokens';

const customerBody = (overrides: Record<string, unknown> = {}) => ({
    email: 'ana@example.com',
    password: 'Str0ngPassw0rd',
    fullName: 'Ana Pop',
    phone: '+40 712 345 678',
    ...overrides,
});

const ownerBody = (overrides: Record<string, unknown> = {}) => customerBody({
    email: 'owner@example.com',
    restaurantName: 'Casa Ana',
    restaurantAddress: 'Strada Lunga 1, Brasov',
    ...overrides,
});

const courierBody = (overrides: Record<string, unknown> = {}) => customerBody({
    email: 'courier@example.com',
    vehicleType: 'bike',
    ...overrides,
});

async function userRow(id: string) {
    const { rows } = await pool.query(
        `SELECT email, role, status, full_name, phone, password_hash, email_verified_at FROM users WHERE id = $1`, [id]);
    return rows[0];
}

describe('POST /customers', () => {
    it('creates a pending_activation customer and returns only id and email', async () => {
        const res = await api().post('/customers').send(customerBody());

        expect(res.status).toBe(201);
        expect(res.body).toEqual({ user: { id: expect.any(String), email: 'ana@example.com' } });

        const user = await userRow(res.body.user.id);
        expect(user).toMatchObject({
            role: 'customer', status: 'pending_activation', full_name: 'Ana Pop',
            phone: '+40 712 345 678', email_verified_at: null,
        });
    });

    it('stores a bcrypt hash, never the plain password', async () => {
        const res = await api().post('/customers').send(customerBody());
        const user = await userRow(res.body.user.id);

        expect(user.password_hash).not.toContain('Str0ngPassw0rd');
        expect(user.password_hash).toMatch(/^\$2[aby]\$12\$/);
        await expect(bcrypt.compare('Str0ngPassw0rd', user.password_hash)).resolves.toBe(true);
    });

    it('prints the activation link and stores only the SHA-256 hash of its token, valid 24 hours', async () => {
        const res = await api().post('/customers').send(customerBody());
        const token = lastActivationToken();

        const { rows } = await pool.query(
            `SELECT type, token_hash, used_at, revoked_at,
                    extract(epoch FROM expires_at - created_at)::int AS ttl
               FROM email_tokens WHERE user_id = $1`, [res.body.user.id]);

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            type: 'activation', token_hash: hashToken(token), used_at: null, revoked_at: null, ttl: 24 * 3600,
        });
        expect(rows[0].token_hash).not.toBe(token);
    });

    it('records the creation in account_status_history with the system actor', async () => {
        const res = await api().post('/customers').send(customerBody());

        const { rows } = await pool.query(
            `SELECT from_status, to_status, actor, reason FROM account_status_history WHERE user_id = $1`,
            [res.body.user.id]);

        expect(rows).toEqual([
            { from_status: null, to_status: 'pending_activation', actor: 'system', reason: 'customer signup' },
        ]);
    });

    it('trims and lowercases the email', async () => {
        const res = await api().post('/customers').send(customerBody({ email: '  Ana.Pop@Example.COM ' }));

        expect(res.status).toBe(201);
        expect(res.body.user.email).toBe('ana.pop@example.com');
    });

    it('rejects a duplicate email, whatever its case, with 409 EMAIL_TAKEN', async () => {
        await api().post('/customers').send(customerBody()).expect(201);

        const res = await api().post('/customers').send(customerBody({ email: 'ANA@example.com' }));

        expect(res.status).toBe(409);
        expect(res.body).toEqual({
            error: { code: 'EMAIL_TAKEN', message: 'An account with this email already exists', details: null },
        });
        expect(await countRows('users')).toBe(1);
        expect(await countRows('email_tokens')).toBe(1);
    });

    it('ignores a role or status sent by the client', async () => {
        const res = await api().post('/customers').send(customerBody({ role: 'admin', status: 'active' }));

        expect(res.status).toBe(201);
        expect(await userRow(res.body.user.id)).toMatchObject({ role: 'customer', status: 'pending_activation' });
    });

    it.each([
        ['missing email', { email: undefined }, 'email'],
        ['invalid email', { email: 'not-an-email' }, 'email'],
        ['password under 8 characters', { password: 'Sh0rt' }, 'password'],
        ['password over 72 bytes (ASCII)', { password: 'a'.repeat(73) }, 'password'],
        ['password over 72 bytes (multi-byte, 37 chars)', { password: 'é'.repeat(37) }, 'password'],
        ['empty full name', { fullName: '   ' }, 'fullName'],
        ['invalid phone', { phone: 'call me' }, 'phone'],
    ])('rejects %s with 400 VALIDATION_ERROR', async (_case, overrides, field) => {
        const res = await api().post('/customers').send(customerBody(overrides));

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.details).toEqual(
            expect.arrayContaining([expect.objectContaining({ field, message: expect.any(String) })]));
        expect(await countRows('users')).toBe(0);
    });

    it('accepts a password of exactly 72 bytes', async () => {
        const res = await api().post('/customers').send(customerBody({ password: 'a'.repeat(72) }));
        expect(res.status).toBe(201);
    });

    it('rejects malformed JSON with 400 INVALID_JSON', async () => {
        const res = await api().post('/customers').set('Content-Type', 'application/json').send('{"email":');

        expect(res.status).toBe(400);
        expect(res.body).toEqual({
            error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON', details: null },
        });
    });
});

describe('POST /restaurant-owners', () => {
    it('creates a pending owner together with a pending application', async () => {
        const res = await api().post('/restaurant-owners').send(ownerBody());

        expect(res.status).toBe(201);
        expect(res.body).toEqual({ user: { id: expect.any(String), email: 'owner@example.com' } });
        expect(await userRow(res.body.user.id)).toMatchObject({ role: 'restaurant_owner', status: 'pending_activation' });

        const { rows } = await pool.query(
            `SELECT role, status, details, restaurant_id, attempt_no, decided_at FROM applications WHERE user_id = $1`,
            [res.body.user.id]);
        expect(rows).toEqual([{
            role: 'restaurant_owner', status: 'pending', restaurant_id: null, attempt_no: 1, decided_at: null,
            details: { restaurantName: 'Casa Ana', restaurantAddress: 'Strada Lunga 1, Brasov' },
        }]);
        expect(printedActivationTokens()).toHaveLength(1);
    });

    it('requires the restaurant name and address', async () => {
        const res = await api().post('/restaurant-owners')
            .send(ownerBody({ restaurantName: undefined, restaurantAddress: '' }));

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        const fields = res.body.error.details.map((d: { field: string }) => d.field);
        expect(fields).toEqual(expect.arrayContaining(['restaurantName', 'restaurantAddress']));
    });

    it('rejects a non-numeric restaurantId with 400', async () => {
        const res = await api().post('/restaurant-owners').send(ownerBody({ restaurantId: '12abc' }));

        expect(res.status).toBe(400);
        expect(res.body.error.details).toEqual([expect.objectContaining({ field: 'restaurantId' })]);
    });

    it('rolls back the whole signup when the picked restaurant does not exist (409 REFERENCE_VIOLATION)', async () => {
        const res = await api().post('/restaurant-owners').send(ownerBody({ restaurantId: '999999' }));

        expect(res.status).toBe(409);
        expect(res.body).toEqual({
            error: {
                code: 'REFERENCE_VIOLATION',
                message: 'Related resource missing or in use',
                details: { constraint: 'applications_restaurant_id_fkey' },
            },
        });
        // Same transaction: no user, no token, no application, and no link printed.
        expect(await countRows('users')).toBe(0);
        expect(await countRows('email_tokens')).toBe(0);
        expect(await countRows('applications')).toBe(0);
        expect(printedActivationTokens()).toHaveLength(0);
    });

    it('rejects an email already used by another role', async () => {
        await createUser({ email: 'owner@example.com', role: 'customer' });

        const res = await api().post('/restaurant-owners').send(ownerBody());

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('EMAIL_TAKEN');
        expect(await countRows('applications')).toBe(0);
    });
});

describe('POST /couriers', () => {
    it('creates a pending courier together with a pending application', async () => {
        const res = await api().post('/couriers').send(courierBody({ vehicleType: 'scooter' }));

        expect(res.status).toBe(201);
        expect(await userRow(res.body.user.id)).toMatchObject({
            role: 'courier', status: 'pending_activation', phone: '+40 712 345 678',
        });

        const { rows } = await pool.query(
            `SELECT role, status, details, restaurant_id FROM applications WHERE user_id = $1`, [res.body.user.id]);
        expect(rows).toEqual([
            { role: 'courier', status: 'pending', details: { vehicleType: 'scooter' }, restaurant_id: null },
        ]);
    });

    it('requires a phone number', async () => {
        const res = await api().post('/couriers').send(courierBody({ phone: undefined }));

        expect(res.status).toBe(400);
        expect(res.body.error.details).toEqual([expect.objectContaining({ field: 'phone' })]);
    });

    it('rejects an unknown vehicle type', async () => {
        const res = await api().post('/couriers').send(courierBody({ vehicleType: 'plane' }));

        expect(res.status).toBe(400);
        expect(res.body.error.details).toEqual([expect.objectContaining({ field: 'vehicleType' })]);
        expect(await countRows('users')).toBe(0);
    });
});
