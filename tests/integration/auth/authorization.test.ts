import express, { type Request, type Response } from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { requireAuth } from '../../../src/middleware/requireAuth';
import { requireRole } from '../../../src/middleware/requireRole';
import { requireLiveSession } from '../../../src/middleware/requireLiveSession';
import { requestLogger } from '../../../src/middleware/requestLogger';
import { errorHandler } from '../../../src/middleware/errorHandler';
import { signAccessToken } from '../../../src/utils/jwt';
import { login, logout, refresh, api, lastResetToken } from '../../helpers/http';
import { pool } from '../../helpers/db';
import { createUser, setUserStatus, type TestUser } from '../../helpers/users';
import { hashToken } from '../../../src/utils/tokens';

// No real route uses the authorization middleware yet, so it is mounted on a small test app,
// with the same logger and error handler as the real one.
const echo = (req: Request, res: Response) => { res.json({ user: req.user }); };
const protectedApp = express();
protectedApp.use(requestLogger);
protectedApp.get('/me', requireAuth, echo);
protectedApp.get('/admin', requireAuth, requireRole('admin'), echo);
protectedApp.get('/staff', requireAuth, requireRole('restaurant_owner', 'courier'), echo);
protectedApp.get('/role-without-auth', requireRole('customer'), echo);
protectedApp.post('/live', requireAuth, requireLiveSession, echo);
protectedApp.post('/live-without-auth', requireLiveSession, echo);
protectedApp.use(errorHandler);

const SECRET = process.env.JWT_SECRET!;
const SID = '00000000-0000-4000-8000-000000000000';
const UNAUTHENTICATED = { error: { code: 'UNAUTHENTICATED', message: 'Authentication required', details: null } };
const FORBIDDEN = { error: { code: 'FORBIDDEN', message: "You don't have access to this resource", details: null } };
const SESSION_ENDED = { error: { code: 'SESSION_ENDED', message: 'Session has ended', details: null } };

const get = (path: string, token?: string) => {
    const req = request(protectedApp).get(path);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
};
const post = (path: string, token?: string) => {
    const req = request(protectedApp).post(path);
    return token === undefined ? req : req.set('Authorization', `Bearer ${token}`);
};

const base64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('requireAuth', () => {
    it('accepts a valid access token and exposes id, role and sid on req.user', async () => {
        const token = signAccessToken({ id: '42', role: 'customer' }, SID);

        const res = await get('/me', token);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ user: { id: '42', role: 'customer', sid: SID } });
    });

    it('accepts the token returned by a real login', async () => {
        const user = await createUser();
        const { accessToken } = await login(user.email, user.password);

        const res = await get('/me', accessToken);

        expect(res.body.user).toMatchObject({ id: user.id, role: 'customer' });
    });

    it('answers 401 UNAUTHENTICATED without an Authorization header', async () => {
        const res = await get('/me');

        expect(res.status).toBe(401);
        expect(res.body).toEqual(UNAUTHENTICATED);
    });

    it.each([
        ['another scheme', 'Basic dXNlcjpwYXNz'],
        ['Bearer with no token', 'Bearer '],
        ['a garbage token', 'Bearer not.a.jwt'],
    ])('answers 401 UNAUTHENTICATED for %s', async (_case, header) => {
        const res = await request(protectedApp).get('/me').set('Authorization', header);

        expect(res.status).toBe(401);
        expect(res.body).toEqual(UNAUTHENTICATED);
    });

    it.each([
        ['signed with another secret', () => jwt.sign({ role: 'customer', sid: SID }, 'another-secret', { subject: '1', algorithm: 'HS256' })],
        ['signed with HS512 (algorithm not allowed)', () => jwt.sign({ role: 'customer', sid: SID }, SECRET, { subject: '1', algorithm: 'HS512' })],
        ['unsigned (alg: none)', () => `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url({ sub: '1', role: 'admin', sid: SID })}.`],
        ['with a tampered payload', () => {
            const [header, , signature] = signAccessToken({ id: '1', role: 'customer' }, SID).split('.');
            return `${header}.${base64url({ sub: '1', role: 'admin', sid: SID, exp: Math.floor(Date.now() / 1000) + 600 })}.${signature}`;
        }],
        ['without sid', () => jwt.sign({ role: 'customer' }, SECRET, { subject: '1', algorithm: 'HS256' })],
        ['without sub', () => jwt.sign({ role: 'customer', sid: SID }, SECRET, { algorithm: 'HS256' })],
        ['with an unknown role', () => jwt.sign({ role: 'superuser', sid: SID }, SECRET, { subject: '1', algorithm: 'HS256' })],
    ])('answers 401 UNAUTHENTICATED for a token %s', async (_case, makeToken) => {
        const res = await get('/me', makeToken());

        expect(res.status).toBe(401);
        expect(res.body).toEqual(UNAUTHENTICATED);
    });

    it('answers 401 ACCESS_TOKEN_EXPIRED for an expired token', async () => {
        const expired = jwt.sign(
            { role: 'customer', sid: SID, exp: Math.floor(Date.now() / 1000) - 10 }, SECRET, { subject: '1', algorithm: 'HS256' });

        const res = await get('/me', expired);

        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: { code: 'ACCESS_TOKEN_EXPIRED', message: 'Access token expired', details: null } });
    });
});

describe('requireRole', () => {
    it.each(['customer', 'restaurant_owner', 'courier'] as const)('answers 403 FORBIDDEN to a %s on an admin route', async (role) => {
        const res = await get('/admin', signAccessToken({ id: '1', role }, SID));

        expect(res.status).toBe(403);
        expect(res.body).toEqual(FORBIDDEN);
    });

    it('lets an admin through', async () => {
        const res = await get('/admin', signAccessToken({ id: '1', role: 'admin' }, SID));
        expect(res.status).toBe(200);
    });

    it.each(['restaurant_owner', 'courier'] as const)('accepts any of several allowed roles (%s)', async (role) => {
        const res = await get('/staff', signAccessToken({ id: '1', role }, SID));
        expect(res.status).toBe(200);
    });

    it('does not let an admin into a route that does not list admin', async () => {
        const res = await get('/staff', signAccessToken({ id: '1', role: 'admin' }, SID));
        expect(res.status).toBe(403);
    });

    it('answers 401 (not 403) when used without requireAuth', async () => {
        const res = await get('/role-without-auth', signAccessToken({ id: '1', role: 'customer' }, SID));

        expect(res.status).toBe(401);
        expect(res.body).toEqual(UNAUTHENTICATED);
    });
});

describe('requireLiveSession', () => {
    let user: TestUser;
    let session: Awaited<ReturnType<typeof login>>;

    beforeEach(async () => {
        user = await createUser();
        session = await login(user.email, user.password);
    });

    it('lets a live session through', async () => {
        const res = await post('/live', session.accessToken);

        expect(res.status).toBe(200);
        expect(res.body.user.id).toBe(user.id);
    });

    it('still accepts the session after a normal refresh rotation', async () => {
        await refresh(session.refreshToken).expect(200);

        expect((await post('/live', session.accessToken)).status).toBe(200);
    });

    it('answers 401 SESSION_ENDED after logout, although the access token has not expired', async () => {
        await logout(session.refreshToken).expect(204);

        const res = await post('/live', session.accessToken);

        expect(res.status).toBe(401);
        expect(res.body).toEqual(SESSION_ENDED);
        // An ordinary stateless route still accepts the same token until it expires.
        expect((await get('/me', session.accessToken)).status).toBe(200);
    });

    it('answers 401 SESSION_ENDED after the family was revoked for token reuse', async () => {
        await refresh(session.refreshToken).expect(200);
        await pool.query(
            `UPDATE refresh_tokens SET created_at = created_at - interval '11 seconds'
              WHERE id = (SELECT replaced_by_id FROM refresh_tokens WHERE token_hash = $1)`, [hashToken(session.refreshToken)]);
        await refresh(session.refreshToken).expect(401);

        expect((await post('/live', session.accessToken)).body).toEqual(SESSION_ENDED);
    });

    it('answers 401 SESSION_ENDED after a password reset', async () => {
        await api().post('/password-resets').send({ email: user.email }).expect(202);
        await api().post('/password-reset-confirmations')
            .send({ token: lastResetToken(), newPassword: 'N3wPassw0rd!' }).expect(204);

        expect((await post('/live', session.accessToken)).body).toEqual(SESSION_ENDED);
    });

    it('answers 401 SESSION_ENDED once every token of the family has expired', async () => {
        await pool.query(
            `UPDATE refresh_tokens SET created_at = now() - interval '31 days', expires_at = now() - interval '1 second'
              WHERE user_id = $1`, [user.id]);

        expect((await post('/live', session.accessToken)).body).toEqual(SESSION_ENDED);
    });

    it('answers 403 ACCOUNT_NOT_ACTIVE when the user was suspended', async () => {
        await setUserStatus(user.id, 'suspended');

        const res = await post('/live', session.accessToken);

        expect(res.status).toBe(403);
        expect(res.body).toEqual({
            error: { code: 'ACCOUNT_NOT_ACTIVE', message: 'Account is not active', details: { status: 'suspended' } },
        });
    });

    it('answers 401 SESSION_ENDED for a valid signature with an unknown sid', async () => {
        const token = signAccessToken({ id: user.id, role: 'customer' }, SID);

        expect((await post('/live', token)).body).toEqual(SESSION_ENDED);
    });

    it("answers 401 SESSION_ENDED for a sid that belongs to another user's session", async () => {
        const other = await createUser();
        const otherSession = await login(other.email, other.password);
        const otherSid = (jwt.decode(otherSession.accessToken) as jwt.JwtPayload).sid;

        const token = signAccessToken({ id: user.id, role: 'customer' }, otherSid);

        expect((await post('/live', token)).body).toEqual(SESSION_ENDED);
    });

    it('answers 401 SESSION_ENDED when the user no longer exists', async () => {
        const token = signAccessToken({ id: '999999', role: 'customer' }, SID);

        expect((await post('/live', token)).body).toEqual(SESSION_ENDED);
    });

    it('answers 401 UNAUTHENTICATED when used without requireAuth', async () => {
        const res = await post('/live-without-auth', session.accessToken);

        expect(res.status).toBe(401);
        expect(res.body).toEqual(UNAUTHENTICATED);
    });
});
