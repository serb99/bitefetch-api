import jwt, { type JwtPayload } from 'jsonwebtoken';
import { login, refresh, refreshCookieLine, refreshTokenFrom } from '../../helpers/http';
import { pool } from '../../helpers/db';
import { createUser, setUserStatus, type TestUser } from '../../helpers/users';
import { hashToken } from '../../../src/utils/tokens';

const INVALID_REFRESH = { error: { code: 'INVALID_REFRESH_TOKEN', message: 'Invalid refresh token', details: null } };
const IN_PROGRESS = { error: { code: 'REFRESH_IN_PROGRESS', message: 'Token was just refreshed, retry', details: null } };

const sidOf = (accessToken: string) => (jwt.decode(accessToken) as JwtPayload).sid as string;

async function tokenRow(rawToken: string) {
    const { rows } = await pool.query(
        `SELECT id, family_id, replaced_by_id, revoked_at FROM refresh_tokens WHERE token_hash = $1`, [hashToken(rawToken)]);
    return rows[0];
}

async function familyRows(familyId: string) {
    const { rows } = await pool.query(
        `SELECT id, revoked_at FROM refresh_tokens WHERE family_id = $1 ORDER BY id`, [familyId]);
    return rows;
}

// Moves the rotation of `rawToken` back in time, past the 10 s grace window.
async function ageRotation(rawToken: string, seconds = 11): Promise<void> {
    await pool.query(
        `UPDATE refresh_tokens SET created_at = created_at - make_interval(secs => $2)
          WHERE id = (SELECT replaced_by_id FROM refresh_tokens WHERE token_hash = $1)`,
        [hashToken(rawToken), seconds]);
}

describe('POST /sessions/refresh', () => {
    let user: TestUser;
    let session: Awaited<ReturnType<typeof login>>;

    beforeEach(async () => {
        user = await createUser();
        session = await login(user.email, user.password);
    });

    it('rotates: returns a new access token and sets a new refresh cookie', async () => {
        const res = await refresh(session.refreshToken);

        expect(res.status).toBe(200);
        expect(Object.keys(res.body)).toEqual(['accessToken']);
        const newToken = refreshTokenFrom(res);
        expect(newToken).toBeDefined();
        expect(newToken).not.toBe(session.refreshToken);

        const line = refreshCookieLine(res)!;
        expect(line).toMatch(/; HttpOnly/i);
        expect(line).toMatch(/; SameSite=Strict/i);
        expect(line).toMatch(/; Path=\/sessions(;|$)/);
    });

    it('keeps the user, role and session id (sid) in the new access token', async () => {
        const res = await refresh(session.refreshToken);

        expect(jwt.decode(res.body.accessToken)).toMatchObject({
            sub: user.id, role: 'customer', sid: sidOf(session.accessToken),
        });
    });

    it('links the old token to its replacement inside the same family', async () => {
        const res = await refresh(session.refreshToken);
        const oldRow = await tokenRow(session.refreshToken);
        const newRow = await tokenRow(refreshTokenFrom(res)!);

        expect(oldRow.replaced_by_id).toBe(newRow.id);
        expect(newRow.family_id).toBe(oldRow.family_id);
        expect(newRow.replaced_by_id).toBeNull();
        expect(oldRow.revoked_at).toBeNull();
        expect(newRow.revoked_at).toBeNull();
    });

    it('can rotate again and again with the latest token', async () => {
        let token = session.refreshToken;
        for (let i = 0; i < 3; i++) {
            const res = await refresh(token);
            expect(res.status).toBe(200);
            token = refreshTokenFrom(res)!;
        }
        expect(await familyRows(sidOf(session.accessToken))).toHaveLength(4);
    });

    it.each([
        ['no cookie', undefined],
        ['an empty cookie', ''],
        ['an unknown token', 'not-a-real-token'],
    ])('answers 401 INVALID_REFRESH_TOKEN for %s', async (_case, token) => {
        const res = await refresh(token);

        expect(res.status).toBe(401);
        expect(res.body).toEqual(INVALID_REFRESH);
        expect(refreshCookieLine(res)).toBeUndefined();
    });

    it('answers 409 REFRESH_IN_PROGRESS when a just-replaced token comes back inside the grace window, and keeps the family', async () => {
        const first = await refresh(session.refreshToken);
        const newToken = refreshTokenFrom(first)!;

        const reuse = await refresh(session.refreshToken);

        expect(reuse.status).toBe(409);
        expect(reuse.body).toEqual(IN_PROGRESS);
        const rows = await familyRows(sidOf(session.accessToken));
        expect(rows.every((r) => r.revoked_at === null)).toBe(true);
        // The winner's token still works.
        expect((await refresh(newToken)).status).toBe(200);
    });

    it('revokes the whole family when a replaced token is reused after the grace window', async () => {
        const first = await refresh(session.refreshToken);
        const newToken = refreshTokenFrom(first)!;
        await ageRotation(session.refreshToken);

        const reuse = await refresh(session.refreshToken);

        expect(reuse.status).toBe(401);
        expect(reuse.body).toEqual(INVALID_REFRESH);
        const rows = await familyRows(sidOf(session.accessToken));
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.revoked_at instanceof Date)).toBe(true);
        // The legitimate holder of the newest token is logged out too.
        const afterRevoke = await refresh(newToken);
        expect(afterRevoke.status).toBe(401);
        expect(afterRevoke.body).toEqual(INVALID_REFRESH);
    });

    it('leaves the other sessions of the same user alive when one family is revoked', async () => {
        const otherDevice = await login(user.email, user.password);
        await refresh(session.refreshToken).expect(200);
        await ageRotation(session.refreshToken);
        await refresh(session.refreshToken).expect(401);

        const res = await refresh(otherDevice.refreshToken);

        expect(res.status).toBe(200);
    });

    it('rejects an expired refresh token', async () => {
        await pool.query(
            `UPDATE refresh_tokens SET created_at = now() - interval '31 days', expires_at = now() - interval '1 second'
              WHERE token_hash = $1`, [hashToken(session.refreshToken)]);

        const res = await refresh(session.refreshToken);

        expect(res.status).toBe(401);
        expect(res.body).toEqual(INVALID_REFRESH);
    });

    it('rejects a revoked refresh token', async () => {
        await pool.query(`UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1`, [hashToken(session.refreshToken)]);

        const res = await refresh(session.refreshToken);

        expect(res.status).toBe(401);
        expect(res.body).toEqual(INVALID_REFRESH);
    });

    it('rejects the refresh once the user is no longer active', async () => {
        await setUserStatus(user.id, 'suspended');

        const res = await refresh(session.refreshToken);

        expect(res.status).toBe(401);
        expect(res.body).toEqual(INVALID_REFRESH);
        const row = await tokenRow(session.refreshToken);
        expect(row.replaced_by_id).toBeNull();
    });

    it('lets exactly one of two parallel refreshes with the same token win', async () => {
        const results = await Promise.all([refresh(session.refreshToken), refresh(session.refreshToken)]);

        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        const loser = results.find((r) => r.status === 409)!;
        expect(loser.body).toEqual(IN_PROGRESS);
        // The loser's insert was rolled back: one original + one replacement, none revoked.
        const rows = await familyRows(sidOf(session.accessToken));
        expect(rows).toHaveLength(2);
        expect(rows.every((r) => r.revoked_at === null)).toBe(true);
    });
});
