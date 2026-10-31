import { pool } from '../../src/database/pool';

async function assertTestDatabase(): Promise<void> {
    const { rows } = await pool.query('SELECT current_database() AS db');
    if (!rows[0].db.endsWith('_test')) {
        throw new Error(`Refusing to touch database "${rows[0].db}": its name must end in _test.`);
    }
}

// Not TRUNCATE ... CASCADE: platform_settings.updated_by references users, so a cascading
// TRUNCATE would also wipe the platform settings seeded by migration 11.
// DELETE follows each foreign key's own rule instead: email_tokens, refresh_tokens, applications
// and account_status_history are ON DELETE CASCADE, platform_settings.updated_by is SET NULL.
async function resetAccountTables(): Promise<void> {
    await pool.query(`
        DELETE FROM users;
        ALTER TABLE users ALTER COLUMN id RESTART;
        ALTER TABLE email_tokens ALTER COLUMN id RESTART;
        ALTER TABLE refresh_tokens ALTER COLUMN id RESTART;
        ALTER TABLE applications ALTER COLUMN id RESTART;
        ALTER TABLE account_status_history ALTER COLUMN id RESTART;
    `);
}

async function countRows(table: 'users' | 'email_tokens' | 'refresh_tokens' | 'applications'): Promise<number> {
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${table}`);
    return rows[0].n;
}

export { pool, assertTestDatabase, resetAccountTables, countRows };
