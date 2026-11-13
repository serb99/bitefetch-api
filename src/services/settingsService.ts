import { pool } from '../database/pool';

// Reads numeric settings from platform_settings (admin-editable, so never hard-code them).
async function getNumberSettings<K extends string>(keys: readonly K[]): Promise<Record<K, number>> {
    const { rows } = await pool.query<{ key: string; value: unknown }>(
        `SELECT key, value FROM platform_settings WHERE key = ANY($1::text[])`,
        [[...keys]]
    )

    const result = {} as Record<K, number>;
    for (const key of keys) {
        const row = rows.find((r) => r.key === key);
        if (!row || typeof row.value !== 'number') {
            // a server configuration problem, not the customer's fault: becomes a generic 500
            throw new Error(`Missing or invalid platform setting: ${key}`);
        }
        result[key] = row.value;
    }
    return result;
}

export { getNumberSettings };