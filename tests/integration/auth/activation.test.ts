import { api, lastActivationToken } from '../../helpers/http';
import { pool } from '../../helpers/db';
import { createUser } from '../../helpers/users';
import { generateToken, hashToken } from '../../../src/utils/tokens';

const PASSWORD = 'Str0ngPassw0rd';

const SIGNUPS = {
    customer: { path: '/customers', body: { email: 'ana@example.com', password: PASSWORD, fullName: 'Ana Pop' } },
    restaurant_owner: {
        path: '/restaurant-owners',
        body: { email: 'owner@example.com', password: PASSWORD, fullName: 'Ion Pop', restaurantName: 'Casa', restaurantAddress: 'Str. 1' },
    },
    courier: {
        path: '/couriers',
        body: { email: 'courier@example.com', password: PASSWORD, fullName: 'Dan Pop', phone: '0712345678', vehicleType: 'car' },
    },
};

async function signup(role: keyof typeof SIGNUPS) {
    const { path, body } = SIGNUPS[role];
    const res = await api().post(path).send(body).expect(201);
    return { userId: res.body.user.id as string, email: body.email, token: lastActivationToken() };
}

const activate = (token: unknown) => api().post('/account-activations').send({ token });

const INVALID_TOKEN = {
    error: { code: 'INVALID_OR_EXPIRED_TOKEN', message: 'Activation link is invalid or has expired', details: null },
};

async function userStatus(userId: string): Promise<string> {
    const { rows } = await pool.query(`SELECT status FROM users WHERE id = $1`, [userId]);
    return rows[0].status;
}

describe('POST /account-activations', () => {
    it('activates a customer, marks the email verified and the token used', async () => {
        const { userId, token } = await signup('customer');

        const res = await activate(token);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ status: 'active', message: 'Account activated' });

        const { rows: [user] } = await pool.query(`SELECT status, email_verified_at FROM users WHERE id = $1`, [userId]);
        expect(user.status).toBe('active');
        expect(user.email_verified_at).toBeInstanceOf(Date);

        const { rows: [emailToken] } = await pool.query(`SELECT used_at FROM email_tokens WHERE user_id = $1`, [userId]);
        expect(emailToken.used_at).toBeInstanceOf(Date);
    });

    it('records the activation in account_status_history', async () => {
        const { userId, token } = await signup('customer');
        await activate(token).expect(200);

        const { rows } = await pool.query(
            `SELECT from_status, to_status, actor, reason FROM account_status_history
              WHERE user_id = $1 ORDER BY id`, [userId]);

        expect(rows[rows.length - 1]).toEqual({
            from_status: 'pending_activation', to_status: 'active', actor: 'system', reason: 'account activation',
        });
    });

    it.each(['restaurant_owner', 'courier'] as const)(
        'moves a %s to pending_approval and leaves the application pending',
        async (role) => {
            const { userId, token } = await signup(role);

            const res = await activate(token);

            expect(res.status).toBe(200);
            expect(res.body).toEqual({ status: 'pending_approval', message: 'Email confirmed, waiting for admin approval' });
            expect(await userStatus(userId)).toBe('pending_approval');
            const { rows } = await pool.query(`SELECT status FROM applications WHERE user_id = $1`, [userId]);
            expect(rows).toEqual([{ status: 'pending' }]);
        });

    it('lets an activated customer log in', async () => {
        const { email, token } = await signup('customer');
        await activate(token).expect(200);

        const res = await api().post('/sessions').send({ email, password: PASSWORD });
        expect(res.status).toBe(201);
    });

    it('accepts a token only once', async () => {
        const { token } = await signup('customer');
        await activate(token).expect(200);

        const res = await activate(token);

        expect(res.status).toBe(400);
        expect(res.body).toEqual(INVALID_TOKEN);
    });

    it('rejects an unknown token', async () => {
        await signup('customer');

        const res = await activate(generateToken());

        expect(res.status).toBe(400);
        expect(res.body).toEqual(INVALID_TOKEN);
    });

    it.each([
        ['missing', undefined],
        ['empty', ''],
        ['whitespace only', '   '],
        ['not a string', 12345],
        ['longer than 200 characters', 'x'.repeat(201)],
    ])('rejects a %s token with 400 VALIDATION_ERROR', async (_case, token) => {
        const res = await activate(token);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.details).toEqual([expect.objectContaining({ field: 'token' })]);
    });

    it('rejects an expired token and leaves the user pending', async () => {
        const { userId, token } = await signup('customer');
        await pool.query(
            `UPDATE email_tokens SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour'
              WHERE user_id = $1`, [userId]);

        const res = await activate(token);

        expect(res.status).toBe(400);
        expect(res.body).toEqual(INVALID_TOKEN);
        expect(await userStatus(userId)).toBe('pending_activation');
    });

    it('rejects a revoked token', async () => {
        const { userId, token } = await signup('customer');
        await pool.query(`UPDATE email_tokens SET revoked_at = now() WHERE user_id = $1`, [userId]);

        const res = await activate(token);

        expect(res.status).toBe(400);
        expect(await userStatus(userId)).toBe('pending_activation');
    });

    it('does not accept a password reset token', async () => {
        const user = await createUser({ status: 'pending_activation' });
        const raw = generateToken();
        await pool.query(
            `INSERT INTO email_tokens (user_id, type, token_hash, expires_at)
             VALUES ($1, 'password_reset', $2, now() + interval '1 hour')`, [user.id, hashToken(raw)]);

        const res = await activate(raw);

        expect(res.status).toBe(400);
        expect(res.body).toEqual(INVALID_TOKEN);
        expect(await userStatus(user.id)).toBe('pending_activation');
    });

    it('rolls back (token stays unused) when the user is no longer pending_activation', async () => {
        const { userId, token } = await signup('customer');
        await pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [userId]);

        const res = await activate(token);

        expect(res.status).toBe(400);
        expect(res.body).toEqual(INVALID_TOKEN);
        const { rows } = await pool.query(`SELECT used_at FROM email_tokens WHERE user_id = $1`, [userId]);
        expect(rows[0].used_at).toBeNull();
        expect(await userStatus(userId)).toBe('suspended');
    });

    it('activates only once when two requests race with the same token', async () => {
        const { userId, token } = await signup('customer');

        const results = await Promise.all([activate(token), activate(token)]);

        expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
        const { rows } = await pool.query(
            `SELECT count(*)::int AS n FROM account_status_history WHERE user_id = $1 AND to_status = 'active'`, [userId]);
        expect(rows[0].n).toBe(1);
    });
});
