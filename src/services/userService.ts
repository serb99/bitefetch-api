import { pool } from '../database/pool';      
import { AppError } from '../errors/AppError';

type Me = { id: string; role: string; fullName: string };

async function getMe(userId: string): Promise<Me> {
    const { rows } = await pool.query<{ id: string; role: string; full_name: string }>(
        `SELECT id, role, full_name FROM users WHERE id = $1 AND deleted_at IS NULL`,
        [userId],
    );
    const user = rows[0];
    if (!user) {
        throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }
    // the database column is snake_case, the API answers in camelCase
    return { id: user.id, role: user.role, fullName: user.full_name };
}

export { getMe };
export type { Me };