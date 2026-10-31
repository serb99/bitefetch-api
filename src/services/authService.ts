import { pool } from '../database/pool';
import { withTransaction } from '../database/transaction';
import bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import type { LoginInput } from "../schemas/loginSchema";
import { AppError } from '../errors/AppError';
import type { AuthenticatedUser} from '../types/auth';
import { generateToken, hashToken } from '../utils/tokens';
import { signAccessToken } from '../utils/jwt';
import { logger } from '../logger';

// A real bcrypt hash of a random string, computed once at startup. It matches no password.
// When the email doesn't exist we still run bcrypt.compare against it, so a login with an
// unknown email takes as long as one with a wrong password. Without it, response time would
// reveal which emails are registered.
const DUMMY_HASH = bcrypt.hashSync(randomUUID(), 12);
const REFRESH_GRACE_MS = 10_000;

interface Session {
    accessToken: string;
    refreshToken: string;
}

const invalidRefreshToken = () => new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid refresh token');
const refreshRace = () => new AppError(409, 'REFRESH_IN_PROGRESS', 'Token was just refreshed, retry');

async function loginUser(input: LoginInput): Promise<AuthenticatedUser>{
    const result = await pool.query(`SELECT id, role, status, password_hash from users
        WHERE lower(email) = $1`, [input.email]);
    const user = result.rows[0];
    const hash = user?.password_hash ?? DUMMY_HASH;
    const passwordOk = await bcrypt.compare(input.password, hash);

    if (!user || !passwordOk) {
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }
    if (user.status !== 'active') {
        throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active', { status: user.status });
    }

    return { id: user.id, role: user.role };
}

async function startSession(user: AuthenticatedUser): Promise<Session>{
    const familyId = randomUUID();
    const refreshToken = generateToken();

    await withTransaction(async (client) => {
        await client.query(`INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
            VALUES ($1, $2, $3, NOW() + INTERVAL '30 days')`, [user.id, hashToken(refreshToken), familyId]);
        await client.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    }, `user:${user.id}`, 'login');

    const accessToken = signAccessToken(user, familyId);
    return { accessToken, refreshToken };
}

async function rotateSession(rawToken: string): Promise<Session>{
    const tokenHash = hashToken(rawToken);
    // Look up the presented token by its hash, together with its user (role, status) and, through a
    // LEFT JOIN on the same table, the token that replaced it (replaced_at). All the checks below
    // use this one row; it's undefined when the token is unknown.
    const result = await pool.query(`SELECT rt.id, rt.user_id, rt.family_id, rt.expires_at, rt.revoked_at, rt.replaced_by_id,
          u.role, u.status, nxt.created_at AS replaced_at
          FROM refresh_tokens rt
          JOIN users u ON u.id = rt.user_id
          LEFT JOIN refresh_tokens nxt ON nxt.id = rt.replaced_by_id
          WHERE rt.token_hash = $1`, [tokenHash]);
    const storedToken = result.rows[0];

    if(!storedToken){
        throw invalidRefreshToken();
    }
    if(storedToken.revoked_at){
        throw invalidRefreshToken();
    }
    if(storedToken.replaced_by_id){
        // How long ago was this token replaced? replaced_at is the creation time of the token that took
        // its place (a Date from pg), so "now - replaced_at" is the time since the rotation, in ms.
        // If it's under the grace window, this is most likely a second request that raced the first
        // (two tabs, a double effect, a retry) and not a stolen token, so we don't revoke the family.
        const withinGrace = Date.now() - storedToken.replaced_at.getTime() < REFRESH_GRACE_MS;
        if(withinGrace) {
            throw refreshRace();
        }
        //otherwise
        //stale or stolen refresh token
        //revoke the whole family
        await pool.query(`UPDATE refresh_tokens set revoked_at = now() 
            WHERE family_id = $1 AND revoked_at IS NULL`, [storedToken.family_id]);
        logger.warn({ userId: storedToken.user_id, familyId: storedToken.family_id }, 'Refresh token reuse detected');
        throw invalidRefreshToken();
    }
    if(storedToken.expires_at <= new Date()){
        throw invalidRefreshToken();
    }
    if(storedToken.status !== 'active'){
        throw invalidRefreshToken();
    }
    
    const newRefreshToken = generateToken();
    const session = await withTransaction(async (client) => {
        const inserted = await client.query(`INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
                VALUES ($1, $2, $3, NOW() + INTERVAL '30 days') RETURNING id`, 
                [storedToken.user_id, hashToken(newRefreshToken), storedToken.family_id]);
        const claim = await client.query(`UPDATE refresh_tokens SET replaced_by_id = $1 
                WHERE id = $2 AND replaced_by_id IS NULL AND revoked_at IS NULL`, 
               [inserted.rows[0].id, storedToken.id]);

        if (claim.rowCount === 0) {
            throw refreshRace();
        }
        const accessToken = signAccessToken({id: storedToken.user_id, role: storedToken.role}, storedToken.family_id);
        
        return { accessToken, refreshToken: newRefreshToken };
    }, `user:${storedToken.user_id}`, 'token refresh');

    return session;
}

async function endSession(rawToken: string): Promise<void>{
    await pool.query(
        `UPDATE refresh_tokens SET revoked_at = now()
                WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)
         AND revoked_at IS NULL`, [hashToken(rawToken)]
    );
}

export { loginUser, startSession, rotateSession, endSession };