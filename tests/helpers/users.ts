import bcrypt from 'bcrypt';
import { withTransaction } from '../../src/database/transaction';
import type { UserRole } from '../../src/types/auth';

const DEFAULT_PASSWORD = 'Str0ngPassw0rd';

type UserStatus = 'pending_activation' | 'pending_approval' | 'active' | 'suspended' | 'rejected' | 'deleted';

interface TestUser {
    id: string;
    email: string;
    password: string;
    role: UserRole;
}

interface CreateUserOptions {
    email?: string;
    password?: string;
    role?: UserRole;
    status?: UserStatus;
}

let counter = 0;

function uniqueEmail(prefix = 'user'): string {
    counter += 1;
    return `${prefix}.${counter}@example.com`;
}

// Inserts a user straight into the database, skipping signup and activation.
// bcrypt cost 4 keeps the tests fast; bcrypt.compare works with any cost.
async function createUser(options: CreateUserOptions = {}): Promise<TestUser> {
    const email = options.email ?? uniqueEmail();
    const password = options.password ?? DEFAULT_PASSWORD;
    const role = options.role ?? 'customer';
    const status = options.status ?? 'active';
    const passwordHash = await bcrypt.hash(password, 4);

    const id = await withTransaction(async (client) => {
        const { rows } = await client.query(
            `INSERT INTO users (email, password_hash, role, status, full_name, email_verified_at, deleted_at)
             VALUES ($1, $2, $3, $4::user_status, 'Test User',
                     CASE WHEN $4::user_status = 'pending_activation' THEN NULL ELSE now() END,
                     CASE WHEN $4::user_status = 'deleted' THEN now() END)
             RETURNING id`,
            [email, passwordHash, role, status]);
        return rows[0].id as string;
    }, 'test:fixture', 'test user');

    return { id, email, password, role };
}

async function setUserStatus(userId: string, status: UserStatus): Promise<void> {
    await withTransaction(async (client) => {
        await client.query(
            `UPDATE users SET status = $1::user_status, deleted_at = CASE WHEN $1::user_status = 'deleted' THEN now() END WHERE id = $2`,
            [status, userId]);
    }, 'test:fixture', 'test status change');
}

export { DEFAULT_PASSWORD, uniqueEmail, createUser, setUserStatus };
export type { TestUser, UserStatus };
