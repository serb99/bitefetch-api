import jwt, { type JwtPayload } from 'jsonwebtoken';
import { api, refreshCookieLine, refreshTokenFrom } from '../../helpers/http';
import { pool, countRows } from '../../helpers/db';
import { createUser, type TestUser, type UserStatus } from '../../helpers/users';
import { hashToken } from '../../../src/utils/tokens';
import type { UserRole } from '../../../src/types/auth';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INVALID_CREDENTIALS = {
    error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password', details: null },
};

const loginRequest = (body: Record<string, unknown>) => api().post('/sessions').send(body);

describe('POST /sessions (login)', () => {
    let user: TestUser;

    beforeEach(async () => {
        user = await createUser({ email: 'ana@example.com' });
    });

    it('returns 201 with only an access token in the body', async () => {
        const res = await loginRequest({ email: user.email, password: user.password });

        expect(res.status).toBe(201);
        expect(Object.keys(res.body)).toEqual(['accessToken']);
        expect(typeof res.body.accessToken).toBe('string');
    });

    it('sets the refreshToken cookie: HttpOnly, SameSite=Strict, Path=/sessions, 30 days, not Secure outside production', async () => {
        const res = await loginRequest({ email: user.email, password: user.password });
        const line = refreshCookieLine(res)!;

        expect(line).toBeDefined();
        expect(line).toMatch(/; HttpOnly/i);
        expect(line).toMatch(/; SameSite=Strict/i);
        expect(line).toMatch(/; Path=\/sessions(;|$)/);
        expect(line).toMatch(/; Max-Age=2592000(;|$)/);
        expect(line).not.toMatch(/; Secure/i);
    });

    it('issues an HS256 access token with sub, role and sid, valid for 15 minutes', async () => {
        const res = await loginRequest({ email: user.email, password: user.password });

        const decoded = jwt.decode(res.body.accessToken, { complete: true })!;
        const payload = decoded.payload as JwtPayload;
        expect(decoded.header.alg).toBe('HS256');
        expect(payload).toMatchObject({ sub: user.id, role: 'customer', sid: expect.stringMatching(UUID) });
        expect(payload.exp! - payload.iat!).toBe(15 * 60);
        expect(() => jwt.verify(res.body.accessToken, process.env.JWT_SECRET!, { algorithms: ['HS256'] })).not.toThrow();
    });

    it('stores only the hash of the refresh token, in a new family whose id is the sid claim', async () => {
        const res = await loginRequest({ email: user.email, password: user.password });
        const refreshToken = refreshTokenFrom(res)!;
        const { sid } = jwt.decode(res.body.accessToken) as JwtPayload;

        const { rows } = await pool.query(
            `SELECT token_hash, family_id, revoked_at, replaced_by_id,
                    extract(epoch FROM expires_at - created_at)::int AS ttl
               FROM refresh_tokens WHERE user_id = $1`, [user.id]);

        expect(rows).toEqual([{
            token_hash: hashToken(refreshToken), family_id: sid, revoked_at: null, replaced_by_id: null, ttl: 30 * 24 * 3600,
        }]);
    });

    it('updates last_login_at', async () => {
        await loginRequest({ email: user.email, password: user.password }).expect(201);

        const { rows } = await pool.query(`SELECT last_login_at FROM users WHERE id = $1`, [user.id]);
        expect(rows[0].last_login_at).toBeInstanceOf(Date);
    });

    it('starts a new session family on every login', async () => {
        const first = await loginRequest({ email: user.email, password: user.password });
        const second = await loginRequest({ email: user.email, password: user.password });

        const sid1 = (jwt.decode(first.body.accessToken) as JwtPayload).sid;
        const sid2 = (jwt.decode(second.body.accessToken) as JwtPayload).sid;
        expect(sid1).not.toBe(sid2);
        expect(refreshTokenFrom(first)).not.toBe(refreshTokenFrom(second));
        expect(await countRows('refresh_tokens')).toBe(2);
    });

    it('accepts the email in any case and with surrounding spaces', async () => {
        const res = await loginRequest({ email: '  ANA@Example.com ', password: user.password });
        expect(res.status).toBe(201);
    });

    it.each(['restaurant_owner', 'courier', 'admin'] as UserRole[])('puts the role %s in the token', async (role) => {
        const other = await createUser({ role });

        const res = await loginRequest({ email: other.email, password: other.password });

        expect(res.status).toBe(201);
        expect(jwt.decode(res.body.accessToken)).toMatchObject({ sub: other.id, role });
    });

    it('answers a wrong password and an unknown email with the same 401, and sets no cookie', async () => {
        const wrongPassword = await loginRequest({ email: user.email, password: 'Wr0ngPassword' });
        const unknownEmail = await loginRequest({ email: 'nobody@example.com', password: user.password });

        for (const res of [wrongPassword, unknownEmail]) {
            expect(res.status).toBe(401);
            expect(res.body).toEqual(INVALID_CREDENTIALS);
            expect(refreshCookieLine(res)).toBeUndefined();
        }
        expect(await countRows('refresh_tokens')).toBe(0);
    });

    it.each([
        ['customer', 'pending_activation'],
        ['courier', 'pending_approval'],
        ['restaurant_owner', 'rejected'],
        ['customer', 'suspended'],
        ['customer', 'deleted'],
    ] as [UserRole, UserStatus][])('refuses a %s in status %s with 403 ACCOUNT_NOT_ACTIVE', async (role, status) => {
        const other = await createUser({ role, status });

        const res = await loginRequest({ email: other.email, password: other.password });

        expect(res.status).toBe(403);
        expect(res.body).toEqual({
            error: { code: 'ACCOUNT_NOT_ACTIVE', message: 'Account is not active', details: { status } },
        });
        expect(refreshCookieLine(res)).toBeUndefined();
        expect(await countRows('refresh_tokens')).toBe(0);
    });

    it('does not reveal the status of an inactive account when the password is wrong', async () => {
        const pending = await createUser({ status: 'pending_activation' });

        const res = await loginRequest({ email: pending.email, password: 'Wr0ngPassword' });

        expect(res.status).toBe(401);
        expect(res.body).toEqual(INVALID_CREDENTIALS);
    });

    it.each([
        ['missing password', { email: 'ana@example.com' }],
        ['empty password', { email: 'ana@example.com', password: '' }],
        ['invalid email', { email: 'ana', password: 'whatever1' }],
        ['password over 72 bytes', { email: 'ana@example.com', password: 'a'.repeat(73) }],
    ])('rejects %s with 400 VALIDATION_ERROR', async (_case, body) => {
        const res = await loginRequest(body);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
});
