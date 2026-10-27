import bcrypt from 'bcrypt';
import { withTransaction } from '../database/transaction';
import { generateToken, hashToken } from '../utils/tokens';
import { AppError } from '../errors/AppError';
import { DatabaseError, PoolClient } from 'pg';
import type { CustomerSignupInput, OwnerSignupInput, CourierSignupInput } from '../schemas/authSchema';

interface CreatedUser{
    id: string;
    email: string;
}

interface NewUserData{
    email: string;
    password: string;
    fullName: string;
    phone?: string;
}

type SignupRole = 'customer' | 'restaurant_owner' | 'courier';

async function registerAccount(
    input: NewUserData,
    role: SignupRole,
    reason: string,
    extra?: (client: PoolClient, user: CreatedUser) => Promise<void>,
): Promise<CreatedUser> {

    const passwordHash = await bcrypt.hash(input.password, 12);
    const token = generateToken();
    try {
           const user = await withTransaction(async (client) => {
                const userCreate = await createPendingUser(client, input, passwordHash, role, token);
                if(extra){
                    await extra(client, userCreate);
                }
                return userCreate;
            }, 'system', reason);

           console.log(`Activation link: http://localhost:3000/auth/activate?token=${token}`);
           return user;
    }
    catch(err){
        if (err instanceof DatabaseError && err.code === '23505' && err.constraint === 'users_email_lower_uq'){
            throw new AppError(409, 'EMAIL_TAKEN', 'An account with this email already exists');
        }
        throw err;
    }
}

async function createPendingUser(
    client: PoolClient,
    data: Omit<NewUserData, 'password'>,
    passwordHash: string,
    role: SignupRole,
    token: string
): Promise<CreatedUser> {
    const insertUser = await client.query(`INSERT INTO users (email, password_hash, role, full_name, phone)
               VALUES ($1, $2, $3, $4, $5) RETURNING id, email`, [data.email, passwordHash, role, data.fullName, data.phone ?? null]);
    
    const user = insertUser.rows[0];

    await client.query(`INSERT INTO email_tokens (user_id, type, token_hash, expires_at)
            VALUES ($1, 'activation', $2, NOW() + INTERVAL '24 hours')`, [user.id, hashToken(token)]);
    
    return user;
}

async function signupCustomer(input: CustomerSignupInput){
    return registerAccount(input, 'customer', 'customer signup');
}

async function signupOwner(input: OwnerSignupInput){
    return registerAccount(input, 'restaurant_owner', 'owner signup', 
        async (client, user) => {
            await client.query(`INSERT INTO applications (user_id, role, details, restaurant_id)
                VALUES ($1, 'restaurant_owner', $2, $3)`, [user.id, 
                { restaurantName: input.restaurantName, restaurantAddress: input.restaurantAddress }, input.restaurantId ?? null]);
        }
    )
}

async function signupCourier(input: CourierSignupInput){
    return registerAccount(input, 'courier', 'courier signup',
        async (client, user) => {
            await client.query(`INSERT INTO applications (user_id, role, details)
                VALUES ($1, 'courier', $2)`,[user.id, { vehicleType: input.vehicleType }]);
        });
}

async function activateAccount(token: string): Promise<string>{
    const tokenHash = hashToken(token);

    return await withTransaction(async (client) => {
        const setEmailTokenUsage = await client.query(`UPDATE email_tokens SET used_at = now() 
             WHERE token_hash = $1 AND type = 'activation' AND used_at IS NULL 
             AND revoked_at IS NULL AND expires_at > now() RETURNING user_id`, [tokenHash]);

        if(setEmailTokenUsage.rows.length === 0) {
            throw new AppError(400, 'INVALID_OR_EXPIRED_TOKEN', 'Activation link is invalid or has expired');
        }

        const activated = await client.query(`UPDATE users SET status = CASE WHEN role = 'customer' 
                                                  THEN 'active'::user_status
                                                  ELSE 'pending_approval'::user_status END,
            email_verified_at = now() WHERE id = $1 AND status = 'pending_activation' RETURNING status`, [setEmailTokenUsage.rows[0].user_id]);
        
        if(activated.rows.length === 0){
            throw new AppError(400, 'INVALID_OR_EXPIRED_TOKEN', 'Activation link is invalid or has expired');
        }
        
        return activated.rows[0].status;
    }, 'system', 'account activation');
}

export { signupCustomer, signupOwner, signupCourier, activateAccount };