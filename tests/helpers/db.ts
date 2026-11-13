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
// The catalog tables go first: restaurants.owner_id and applications.restaurant_id are
// ON DELETE RESTRICT, so users cannot be deleted while a restaurant or application points at them.
// Deleting restaurants cascades to restaurant_item_availability.
// M4: orders and their children are RESTRICT on every side (orders are never deleted in the app),
// so they go before restaurants and users. Deleting users cascades to delivery_addresses and carts,
// and carts cascade to cart_items.
async function resetAccountTables(): Promise<void> {
    await pool.query(`
        DELETE FROM order_status_history;
        DELETE FROM order_items;
        DELETE FROM orders;
        DELETE FROM route_cache;
        DELETE FROM osm_search_cache;
        DELETE FROM applications;
        DELETE FROM restaurants;
        DELETE FROM menu_items;
        DELETE FROM brands;
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
