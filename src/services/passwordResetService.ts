import { pool } from '../database/pool';
import bcrypt from 'bcrypt';
import { withTransaction } from '../database/transaction';
import { generateToken, hashToken } from '../utils/tokens';
import type { RequestResetInput, ConfirmResetInput } from '../schemas/passwordResetSchema';
import { AppError } from '../errors/AppError';

const invalidResetToken = () => 
    new AppError(400, 'INVALID_OR_EXPIRED_TOKEN', 'Invalid or expired reset token');

async function requestPasswordReset(input: RequestResetInput): Promise<void>{
    const result = await pool.query(
        `SELECT id, status FROM users WHERE lower(email) = $1`,
        [input.email]
    );
    const user = result.rows[0];

    // Unknown email or account not active: do nothing, and let the handler answer
    // exactly as it does on success, so the endpoint doesn't reveal which emails exist.
    if (!user || user.status !== 'active') {
        return;
    }

    const token = generateToken();
    await withTransaction(async (client) => {
        // Only one open reset token per user: revoke the previous ones first.
        await client.query(
            `UPDATE email_tokens SET revoked_at = now()
              WHERE user_id = $1 AND type = 'password_reset'
                AND used_at IS NULL AND revoked_at IS NULL`,
            [user.id]
        );
        await client.query(
            `INSERT INTO email_tokens (user_id, type, token_hash, expires_at)
             VALUES ($1, 'password_reset', $2, now() + interval '1 hour')`,
            [user.id, hashToken(token)]
        );
    }, 'system', 'password reset requested');

    // Development only: there's no mailer yet, so print the link.
    console.log(`Password reset link: http://localhost:5173/reset-password#token=${token}`);
}

async function confirmPasswordReset(input: ConfirmResetInput): Promise<void>{
    // Slow (bcrypt), so it runs before the transaction and doesn't hold a connection.
    const passwordHash = await bcrypt.hash(input.newPassword, 12);

    //if the password changed but the old sessions
    //stayed alive, a thief who had a session would keep access after the reset.
    await withTransaction(async (client) => {
        // 1. Mark the token as used.
        // Two requests with the same token, only one gets a row.
        const claim = await client.query(`
            UPDATE email_tokens SET used_at = now()
              WHERE token_hash = $1 AND type = 'password_reset'
                AND used_at IS NULL AND revoked_at IS NULL AND expires_at > now()
              RETURNING user_id`,
            [hashToken(input.token)]);

        if (claim.rows.length === 0) {
            throw invalidResetToken();
        }
        const userId = claim.rows[0].user_id;

        // 2. New password and token_version bump. Only for active users.
        const update = await client.query(
            `UPDATE users SET password_hash = $1, token_version = token_version + 1
              WHERE id = $2 AND status = 'active'`, [passwordHash, userId]
        );
        if (update.rowCount === 0) {
            throw invalidResetToken(); // rolls back
        }

        // 3. Log out every device: revoke all refresh tokens of the user, in all families.
        await client.query(
            `UPDATE refresh_tokens SET revoked_at = now()
              WHERE user_id = $1 AND revoked_at IS NULL`,
            [userId]
        );
    }, 'system', 'password reset');
}

export { requestPasswordReset, confirmPasswordReset};