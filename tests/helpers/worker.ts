import { pool } from './db';
import { clearSettingsCache } from '../../src/services/settingsService';

// M8: the worker process and its sweepers (reconciliation, auto-offline, retention, settings cache).

// platform_settings is NOT reset between tests (resetAccountTables keeps the seeded values), so a test that
// changes a setting must put it back: setSetting remembers the original, restoreSettings (afterEach) restores it.
const originals = new Map<string, unknown>();

async function setSetting(key: string, value: number): Promise<void> {
    if (!originals.has(key)) {
        const { rows } = await pool.query(`SELECT value FROM platform_settings WHERE key = $1`, [key]);
        if (!rows[0]) throw new Error(`setSetting: no platform setting ${key}`);
        originals.set(key, rows[0].value);
    }
    await pool.query(`UPDATE platform_settings SET value = $2::jsonb WHERE key = $1`, [key, JSON.stringify(value)]);
}

async function restoreSettings(): Promise<void> {
    for (const [key, value] of originals) {
        await pool.query(`UPDATE platform_settings SET value = $2::jsonb WHERE key = $1`, [key, JSON.stringify(value)]);
    }
    originals.clear();
    clearSettingsCache();
}

// The order was created `seconds` ago (reconciliation only looks at orders older than reconcile_after_s).
async function ageOrder(orderId: string, seconds: number): Promise<void> {
    await pool.query(`UPDATE orders SET created_at = now() - make_interval(secs => $2) WHERE id = $1`, [orderId, seconds]);
}

export { setSetting, restoreSettings, ageOrder };
