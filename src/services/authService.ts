import bcrypt from 'bcrypt';
import { withTransaction } from '../database/transaction';
import { generateToken, hashToken } from '../utils/tokens';
import { AppError } from '../errors/AppError';
import { DatabaseError } from 'pg';
import type { CustomerSignupInput } from '../schemas/authSchema';

async function signupCustomer(input: CustomerSignupInput){
    const passwordHash = await bcrypt.hash(input.password, 12);
    const token = generateToken();
    try {
          const result = await withTransaction(async (client) => {
          const insertCustomerQuery = await client.query(`INSERT INTO users (email, password_hash, role, full_name, phone) 
                    VALUES ($1, $2, 'customer', $3, $4) RETURNING id, email`, [input.email, passwordHash, input.fullName, input.phone ?? null]);
          const user = insertCustomerQuery.rows[0];

          await client.query(`INSERT INTO email_tokens (user_id, type, token_hash, expires_at)
                    VALUES ($1, 'activation', $2, NOW() + INTERVAL '24 hours')`, [user.id, hashToken(token)]);
          return user;
        }, 'system', 'customer signup');

        console.log(`Activation link: http://localhost:3000/auth/activate?token=${token}`);
        return result;
    }
    catch(err){
        if (err instanceof DatabaseError && err.code === '23505' && err.constraint === 'users_email_lower_uq'){
            throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
        }
        throw err;
    }
}

async function activateAccount(token: string): Promise<void>{
    const tokenHash = hashToken(token);

    await withTransaction(async (client) => {
        const setEmailTokenUsage = await client.query(`UPDATE email_tokens SET used_at = now() 
             WHERE token_hash = $1 AND type = 'activation' AND used_at IS NULL 
             AND revoked_at IS NULL AND expires_at > now() RETURNING user_id`, [tokenHash]);

        if(setEmailTokenUsage.rows.length === 0) {
            throw new AppError(400, 'INVALID_OR_EXPIRED_TOKEN', 'Activation link is invalid or has expired');
        }

        // customers only; owners/couriers go to pending_approval
        const activated = await client.query(`UPDATE users SET status = 'active', email_verified_at = now()
             WHERE id = $1 AND status = 'pending_activation'`, [setEmailTokenUsage.rows[0].user_id]);
        
        if(activated.rowCount === 0){
            throw new AppError(400, 'INVALID_OR_EXPIRED_TOKEN', 'Activation link is invalid or has expired');
        }
        
    }, 'system', 'account activation');
}

export { signupCustomer, activateAccount };