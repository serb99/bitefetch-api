import { pool } from '../database/pool';

// platform_settings is admin-editable, so never hard-code the values. But they change rarely and
// are read on almost every request and every worker pass, so each process keeps them for a while:
// an admin change is picked up within CACHE_MS.
const CACHE_MS = 10_000;

type Snapshot = { values: Map<string, unknown>; loadedAt: number };
let snapshot: Snapshot | null = null;
// The reload running right now, shared by every caller that needs it at the same moment
let loading: Promise<Snapshot> | null = null;

async function loadAll(): Promise<Snapshot> {
    const { rows } = await pool.query<{ key: string; value: unknown }>(
        `SELECT key, value FROM platform_settings`
    );
    return { values: new Map(rows.map((r) => [r.key, r.value])), loadedAt: Date.now() };
}

function currentSettings(): Promise<Snapshot> {
    if (snapshot && Date.now() - snapshot.loadedAt < CACHE_MS) {
        return Promise.resolve(snapshot);
    }
    if (!loading) {
        loading = loadAll()
            .then((loaded) => {
                snapshot = loaded;
                return loaded;
            })
            .finally(() => {
                loading = null;
            })
    }
    return loading;
}

async function getNumberSettings<K extends string>(keys: readonly K[]):  Promise<Record<K, number>>{
    const { values } = await currentSettings();

    const result = {} as Record<K, number>;
    for (const key of keys) {
        const value = values.get(key);
         if (typeof value !== 'number') {
            // a server configuration problem, not the customer's fault: becomes a generic 500
            throw new Error(`Missing or invalid platform setting: ${key}`);
        }
        result[key] = value;
    }
    return result;
}

function clearSettingsCache(): void {
    snapshot = null;
}

export { getNumberSettings, clearSettingsCache };