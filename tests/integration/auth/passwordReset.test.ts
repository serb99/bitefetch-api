import { api, login, refresh, lastActivationToken, lastResetToken, printedResetTokens } from '../../helpers/http';
import { pool, countRows } from '../../helpers/db';
import { createUser, setUserStatus, type TestUser } from '../../helpers/users';
import { hashToken } from '../../../src/utils/tokens';

const NEW_PASSWORD = 'N3wPassw0rd!';
const ACCEPTED = { message: 'If an account exists for this email, a reset link has been sent.' };
const INVALID_TOKEN = {
    error: { code: 'INVALID_OR_EXPIRED_TOKEN', message: 'Invalid or expired reset token', details: null },
};

const requestReset = (email: unknown) => api().post('/password-resets').send({ email });
const confirmReset = (token: unknown, newPassword: unknown = NEW_PASSWORD) =>
    api().post('/password-reset-confirmations').send({ token, newPassword });

async function resetTokens(userId: string) {
    const { rows } = await pool.query(
        `SELECT token_hash, used_at, revoked_at, extract(epoch FROM expires_at - created_at)::int AS ttl
           FROM email_tokens WHERE user_id = $1 AND type = 'password_reset' ORDER BY id`, [userId]);
    return rows;
}

async function requestTokenFor(user: TestUser): Promise<string> {
    await requestReset(user.email).expect(202);
    return lastResetToken();
}

describe('POST /password-resets', () => {
    it('answers 202 and stores only the hash of the token, valid 1 hour', async () => {
        const user = await createUser();

        const res = await requestReset(user.email);

        expect(res.status).toBe(202);
        expect(res.body).toEqual(ACCEPTED);
        const token = lastResetToken();
        expect(await resetTokens(user.id)).toEqual([
            { token_hash: hashToken(token), used_at: null, revoked_at: null, ttl: 3600 },
        ]);
    });

    it('answers the same 202 for an unknown email and creates nothing', async () => {
        const res = await requestReset('nobody@example.com');

        expect(res.status).toBe(202);
        expect(res.body).toEqual(ACCEPTED);
        expect(await countRows('email_tokens')).toBe(0);
        expect(printedResetTokens()).toHaveLength(0);
    });

    it.each(['pending_activation', 'suspended'] as const)(
        'answers the same 202 for a %s account and creates nothing', async (status) => {
            const user = await createUser({ status });

            const res = await requestReset(user.email);

            expect(res.status).toBe(202);
            expect(res.body).toEqual(ACCEPTED);
            expect(await resetTokens(user.id)).toEqual([]);
            expect(printedResetTokens()).toHaveLength(0);
        });

    it('matches the email case-insensitively and trims it', async () => {
        const user = await createUser({ email: 'ana@example.com' });

        await requestReset('  ANA@Example.com ').expect(202);

        expect(await resetTokens(user.id)).toHaveLength(1);
    });

    it('revokes the previous open token when a new one is requested', async () => {
        const user = await createUser();
        const first = await requestTokenFor(user);
        const second = await requestTokenFor(user);

        const rows = await resetTokens(user.id);
        expect(rows).toHaveLength(2);
        expect(rows[0].revoked_at).toBeInstanceOf(Date);
        expect(rows[1].revoked_at).toBeNull();

        expect((await confirmReset(first)).body).toEqual(INVALID_TOKEN);
        expect((await confirmReset(second)).status).toBe(204);
    });

    it.each([['missing', undefined], ['invalid', 'not-an-email']])('rejects a %s email with 400', async (_case, email) => {
        const res = await requestReset(email);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
});

describe('POST /password-reset-confirmations', () => {
    let user: TestUser;

    beforeEach(async () => {
        user = await createUser({ email: 'ana@example.com' });
    });

    it('answers 204, the new password works and the old one does not', async () => {
        const token = await requestTokenFor(user);

        const res = await confirmReset(token);

        expect(res.status).toBe(204);
        expect(res.text).toBe('');
        expect((await api().post('/sessions').send({ email: user.email, password: user.password })).status).toBe(401);
        expect((await api().post('/sessions').send({ email: user.email, password: NEW_PASSWORD })).status).toBe(201);
    });

    it('marks the token used, bumps token_version and logs out every device', async () => {
        const laptop = await login(user.email, user.password);
        const phone = await login(user.email, user.password);
        const token = await requestTokenFor(user);

        await confirmReset(token).expect(204);

        expect((await resetTokens(user.id))[0].used_at).toBeInstanceOf(Date);
        const { rows: [u] } = await pool.query(`SELECT token_version, status FROM users WHERE id = $1`, [user.id]);
        expect(u).toEqual({ token_version: 1, status: 'active' });
        const { rows } = await pool.query(
            `SELECT count(*)::int AS live FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
        expect(rows[0].live).toBe(0);
        expect((await refresh(laptop.refreshToken)).status).toBe(401);
        expect((await refresh(phone.refreshToken)).status).toBe(401);
    });

    it('accepts a token only once', async () => {
        const token = await requestTokenFor(user);
        await confirmReset(token).expect(204);

        const res = await confirmReset(token, 'An0therPassword');

        expect(res.status).toBe(400);
        expect(res.body).toEqual(INVALID_TOKEN);
        expect((await api().post('/sessions').send({ email: user.email, password: NEW_PASSWORD })).status).toBe(201);
    });

    it('rejects an unknown token', async () => {
        const res = await confirmReset('not-a-real-token');

        expect(res.status).toBe(400);
        expect(res.body).toEqual(INVALID_TOKEN);
    });

    it('rejects an expired token', async () => {
        const token = await requestTokenFor(user);
        await pool.query(
            `UPDATE email_tokens SET created_at = now() - interval '2 hours', expires_at = now() - interval '1 hour'
              WHERE user_id = $1`, [user.id]);

        const res = await confirmReset(token);

        expect(res.status).toBe(400);
        expect(res.body).toEqual(INVALID_TOKEN);
    });

    it('does not accept an activation token, and leaves that token usable for activation', async () => {
        await api().post('/customers')
            .send({ email: 'new@example.com', password: 'Str0ngPassw0rd', fullName: 'New User' }).expect(201);
        const activationToken = lastActivationToken();

        const res = await confirmReset(activationToken);

        expect(res.status).toBe(400);
        expect(res.body).toEqual(INVALID_TOKEN);
        expect((await api().post('/account-activations').send({ token: activationToken })).status).toBe(200);
    });

    it('rolls back when the user stopped being active: token stays unused, password unchanged', async () => {
        const token = await requestTokenFor(user);
        await setUserStatus(user.id, 'suspended');

        const res = await confirmReset(token);

        expect(res.status).toBe(400);
        expect(res.body).toEqual(INVALID_TOKEN);
        expect((await resetTokens(user.id))[0].used_at).toBeNull();
        await setUserStatus(user.id, 'active');
        expect((await api().post('/sessions').send({ email: user.email, password: user.password })).status).toBe(201);
    });

    it.each([
        ['missing token', { newPassword: NEW_PASSWORD }, 'token'],
        ['empty token', { token: '', newPassword: NEW_PASSWORD }, 'token'],
        ['short password', { token: 'x', newPassword: 'Sh0rt' }, 'newPassword'],
        ['password over 72 bytes', { token: 'x', newPassword: 'a'.repeat(73) }, 'newPassword'],
    ])('rejects a %s with 400 VALIDATION_ERROR', async (_case, body, field) => {
        const res = await api().post('/password-reset-confirmations').send(body);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(res.body.error.details).toEqual(expect.arrayContaining([expect.objectContaining({ field })]));
    });

    it('keeps the token usable after a request rejected by validation', async () => {
        const token = await requestTokenFor(user);
        await confirmReset(token, 'Sh0rt').expect(400);

        expect((await confirmReset(token)).status).toBe(204);
    });

    it('lets exactly one of two parallel confirmations with the same token win', async () => {
        const token = await requestTokenFor(user);

        const results = await Promise.all([confirmReset(token, 'Passw0rdOne'), confirmReset(token, 'Passw0rdTwo')]);

        expect(results.map((r) => r.status).sort()).toEqual([204, 400]);
        const { rows } = await pool.query(`SELECT token_version FROM users WHERE id = $1`, [user.id]);
        expect(rows[0].token_version).toBe(1);
    });
});
