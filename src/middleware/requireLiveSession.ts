import type { Request, Response, NextFunction } from 'express';
import { pool } from '../database/pool';
import { unauthenticated, sessionEnded,  } from '../errors/authErrors';
import { AppError } from '../errors/AppError';

async function requireLiveSession(req: Request, res: Response, next: NextFunction): Promise<void>{
    if (!req.user) {
        throw unauthenticated();
    }

    const result = await pool.query(
        `SELECT u.status, EXISTS (
                    SELECT 1 FROM refresh_tokens rt
                     WHERE rt.family_id = $2 AND rt.user_id = $1
                       AND rt.revoked_at IS NULL AND rt.expires_at > now()
                ) AS session_live
           FROM users u
          WHERE u.id = $1`, [req.user.id, req.user.sid]);
    const row = result.rows[0];

    if (!row || !row.session_live) {
        throw sessionEnded();
    }
    if (row.status !== 'active') {
        throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active', { status: row.status });
    }

    next();
}

export { requireLiveSession };