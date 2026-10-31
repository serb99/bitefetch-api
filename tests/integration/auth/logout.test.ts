import jwt, { type JwtPayload } from 'jsonwebtoken';
import { login, logout, refresh, refreshCookieLine, refreshTokenFrom } from '../../helpers/http';
import { pool } from '../../helpers/db';
import { createUser, type TestUser } from '../../helpers/users';

const sidOf = (accessToken: string) => (jwt.decode(accessToken) as JwtPayload).sid as string;

async function familyRevoked(familyId: string): Promise<boolean[]> {
    const { rows } = await pool.query(
        `SELECT revoked_at IS NOT NULL AS revoked FROM refresh_tokens WHERE family_id = $1 ORDER BY id`, [familyId]);
    return rows.map((r) => r.revoked);
}

describe('DELETE /sessions/current (logout)', () => {
    let user: TestUser;

    beforeEach(async () => {
        user = await createUser();
    });

    it('answers 204 with no body and revokes the session family', async () => {
        const session = await login(user.email, user.password);

        const res = await logout(session.refreshToken);

        expect(res.status).toBe(204);
        expect(res.text).toBe('');
        expect(await familyRevoked(sidOf(session.accessToken))).toEqual([true]);
    });

    it('clears the cookie with the same attributes it was set with', async () => {
        const session = await login(user.email, user.password);

        const res = await logout(session.refreshToken);
        const line = refreshCookieLine(res)!;

        expect(line).toMatch(/^refreshToken=;/);
        expect(line).toMatch(/; Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
        expect(line).toMatch(/; Path=\/sessions(;|$)/);
        expect(line).toMatch(/; HttpOnly/i);
        expect(line).toMatch(/; SameSite=Strict/i);
    });

    it('makes the refresh token unusable', async () => {
        const session = await login(user.email, user.password);
        await logout(session.refreshToken).expect(204);

        const res = await refresh(session.refreshToken);

        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('also revokes the earlier, already rotated tokens of the family', async () => {
        const session = await login(user.email, user.password);
        const rotated = refreshTokenFrom(await refresh(session.refreshToken).expect(200))!;

        await logout(rotated).expect(204);

        expect(await familyRevoked(sidOf(session.accessToken))).toEqual([true, true]);
    });

    it('leaves the other sessions of the user alive', async () => {
        const laptop = await login(user.email, user.password);
        const phone = await login(user.email, user.password);

        await logout(laptop.refreshToken).expect(204);

        expect((await refresh(phone.refreshToken)).status).toBe(200);
        expect(await familyRevoked(sidOf(phone.accessToken))).toEqual([false, false]);
    });

    it.each([
        ['without a cookie', undefined],
        ['with an unknown token', 'not-a-real-token'],
    ])('is idempotent: 204 %s', async (_case, token) => {
        const res = await logout(token);

        expect(res.status).toBe(204);
        expect(refreshCookieLine(res)).toMatch(/^refreshToken=;/);
    });

    it('answers 204 when the session was already logged out', async () => {
        const session = await login(user.email, user.password);
        await logout(session.refreshToken).expect(204);

        expect((await logout(session.refreshToken)).status).toBe(204);
    });
});
