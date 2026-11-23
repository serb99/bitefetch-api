import { pool } from '../database/pool';
import { withTransaction } from '../database/transaction';
import { logger } from '../logger';
import { getNumberSettings } from './settingsService';
import { releasePendingOffer } from './courierService';

const MAX_COURIERS_PER_PASS = 50;
const ACTOR = 'system:auto-offline';
// "Has no fresh position" and "has no active delivery", as SQL, written once for both queries below.
// $1 = courier_no_position_offline_s. A courier on a delivery is never touched
const SILENT_AND_FREE = `
    NOT EXISTS (
        SELECT 1 FROM courier_positions p
         WHERE p.courier_id = cp.user_id
           AND p.received_at > now() - make_interval(secs => $1)
    )
    AND NOT EXISTS (
        SELECT 1 FROM orders o
         WHERE o.courier_id = cp.user_id
           AND o.status IN ('accepted', 'ready_for_pickup', 'picked_up')
    )`;

async function setOfflineIfStillSilent(courierId: string, offlineAfterS: number): Promise<boolean> {
    return withTransaction(async (client) => {
        const { rows } = await client.query(
            `SELECT 1 FROM users WHERE id = $1 AND status = 'active' FOR NO KEY UPDATE SKIP LOCKED`,
            [courierId]
        );
        if (!rows[0]) return false;

        const result = await client.query(
            `UPDATE courier_profiles cp
                SET availability = 'offline',
                    offline_reason = 'no_position'
              WHERE cp.user_id = $2
                AND cp.availability = 'online'
                AND ${SILENT_AND_FREE}`,
            [offlineAfterS, courierId]
        );
        return result.rowCount === 1;
    }, ACTOR, 'no position received');
}

// Called by the worker every 15 s. Returns how many couriers it set offline.
async function setSilentCouriersOffline(): Promise<number> {
    const { courier_no_position_offline_s: offlineAfterS } = await getNumberSettings(
        ['courier_no_position_offline_s'] as const
    );

    // No lock: only a list of candidates. Each one is checked again under the lock.
    const { rows } = await pool.query<{ id: string }>(
        `SELECT cp.user_id AS id
           FROM courier_profiles cp
           JOIN users u ON u.id = cp.user_id AND u.status = 'active'
          WHERE cp.availability = 'online'
            AND ${SILENT_AND_FREE}
          LIMIT $2`,
        [offlineAfterS, MAX_COURIERS_PER_PASS]
    );

    let count = 0;
    for (const { id } of rows) {
        if (!(await setOfflineIfStillSilent(id, offlineAfterS))) continue;
        count++;
        logger.info({ courierId: id, offlineAfterS }, 'Courier set offline: no position');
        await releasePendingOffer(id, ACTOR).catch((err) =>
            logger.error({ err, courierId: id }, 'Could not release the offer of an auto-offline courier')
        );
    }
    return count;
}

export { setSilentCouriersOffline };