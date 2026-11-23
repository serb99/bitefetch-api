import { pool } from '../../helpers/db';
import { createUser } from '../../helpers/users';
import { runRetention } from '../../../src/services/retention';

// M8 retention: the worker calls run_retention() (SQL, constraints.sql §12) once an hour.
// Only a few of its rules are checked here: the job's part is calling it and adding up what it deleted.

async function outboxRowProcessedDaysAgo(days: number): Promise<string> {
    const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO outbox (topic, payload, idempotency_key, attempts, processed_at)
         VALUES ('payment.void', '{}'::jsonb, $1, 1, now() - make_interval(days => $2))
         RETURNING id`,
        [`retention-test:${days}`, days]
    );
    return rows[0].id;
}

async function routeCacheRow(key: string, expiresInS: number): Promise<void> {
    await pool.query(
        `INSERT INTO route_cache (cache_key, distance_m, duration_s, polyline, expires_at)
         VALUES ($1, 1000, 120, 'abc', now() + make_interval(secs => $2))`,
        [key, expiresInS]
    );
}

async function exists(table: 'outbox' | 'users', id: string): Promise<boolean> {
    const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
    return rows.length === 1;
}

async function routeCached(key: string): Promise<boolean> {
    const { rows } = await pool.query(`SELECT 1 FROM route_cache WHERE cache_key = $1`, [key]);
    return rows.length === 1;
}

it('deletes what is past its retention, keeps the rest, and returns the total', async () => {
    const oldOutbox = await outboxRowProcessedDaysAgo(8);
    const recentOutbox = await outboxRowProcessedDaysAgo(6);
    await routeCacheRow('expired', -60);
    await routeCacheRow('valid', 3_600);
    const neverActivated = await createUser({ status: 'pending_activation' });
    const newSignup = await createUser({ status: 'pending_activation' });
    await pool.query(`UPDATE users SET created_at = now() - interval '8 days' WHERE id = $1`, [neverActivated.id]);

    const deleted = await runRetention();

    expect(deleted).toBe(3);
    expect(await exists('outbox', oldOutbox)).toBe(false);
    expect(await exists('outbox', recentOutbox)).toBe(true);
    expect(await routeCached('expired')).toBe(false);
    expect(await routeCached('valid')).toBe(true);
    expect(await exists('users', neverActivated.id)).toBe(false);
    expect(await exists('users', newSignup.id)).toBe(true);
});

it('nothing to delete: returns 0, and a second run right after is harmless', async () => {
    expect(await runRetention()).toBe(0);
    expect(await runRetention()).toBe(0);
});

it('keeps the next months of order_status_history partitioned (created ahead)', async () => {
    await runRetention();

    const { rows } = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM pg_inherits i
           JOIN pg_class parent ON parent.oid = i.inhparent
           JOIN pg_class child ON child.oid = i.inhrelid
          WHERE parent.relname = 'order_status_history'
            AND child.relname <> 'order_status_history_default'`
    );
    expect(rows[0].n).toBeGreaterThanOrEqual(3);
});
