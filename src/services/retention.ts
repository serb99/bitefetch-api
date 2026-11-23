import { pool } from '../database/pool';
import { logger } from '../logger';

type RetentionRow = { target: string; deleted: string }; // bigint arrives as a string

// Deletes old rows (processed outbox after 7 days, expired caches, old tokens, unactivated
// accounts after 7 days...). The rules live in the SQL function run_retention(),
// which deletes at most 5000 rows per table per call. Called by the worker once an hour.
async function runRetention(): Promise<number> {
    const { rows } = await pool.query<RetentionRow>(`SELECT target, deleted FROM run_retention()`);

    const deleted = rows
        .map((row) => ({ target: row.target, deleted: Number(row.deleted) }))
        .filter((row) => row.deleted > 0);
    if (deleted.length > 0) {
        logger.info({ deleted }, 'Retention pass');
    }
    return deleted.reduce((sum, row) => sum + row.deleted, 0);
}

export { runRetention };