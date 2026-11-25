import { pool } from '../database/pool';
import { logger } from '../logger';
import { getNumberSettings } from './settingsService';

const MAX_ORDERS_PER_PASS = 100;

type OpenedIncident = { orderId: string };

// kitchen_late: still accepted kitchen_late_after_s (10 min) after estimated_ready_at.
// delivery_overdue: still picked_up delivery_overdue_after_s (30 min) after estimated_delivery_at.
// Neither changes the order: they only show up for the admin (and later the owner / support).
//
// Each sweep is one statement:
// - due: the late orders, locked FOR UPDATE SKIP LOCKED. The lock re-checks the status on the newest row,
//   so an order that was marked ready or delivered in the meantime drops out: no incident on it.
//   If the sweep locks first, ready / deliver wait and then resolve the new incident. Never two open (unique index).
// - NOT EXISTS any incident of that type for the order, resolved or not: one per order. If the admin
//   resolved it while the order is still late, the sweep does not open it again.
const SWEEPS = {
    kitchen_late: {
        status: 'accepted',
        dueColumn: 'estimated_ready_at',
        settingKey: 'kitchen_late_after_s',
        details: 'Not marked ready 10 minutes after the promised time'
    },
    delivery_overdue: {
        status: 'picked_up',
        dueColumn: 'estimated_delivery_at',
        settingKey: 'delivery_overdue_after_s',
        details: 'Not delivered 30 minutes after the estimated time'
    }
} as const;

async function openLateIncidents(type: keyof typeof SWEEPS): Promise<number> {
    const sweep = SWEEPS[type];
    const settings = await getNumberSettings([sweep.settingKey] as const);
    const afterS: number = settings[sweep.settingKey];

    const { rows } = await pool.query<OpenedIncident>(
        `WITH due AS (
             SELECT o.id, o.restaurant_id
               FROM orders o
              WHERE o.status = '${sweep.status}'
                AND o.${sweep.dueColumn} <= now() - make_interval(secs => $1)
                AND NOT EXISTS (
                    SELECT 1 FROM order_incidents i
                     WHERE i.order_id = o.id AND i.type = '${type}')
              ORDER BY o.${sweep.dueColumn}
              LIMIT $2
              FOR UPDATE OF o SKIP LOCKED
         )
         INSERT INTO order_incidents (order_id, restaurant_id, type, opened_by, details)
         SELECT id, restaurant_id, '${type}', 'system', $3
           FROM due
         ON CONFLICT (order_id, type) WHERE resolved_at IS NULL AND order_id IS NOT NULL DO NOTHING
         RETURNING order_id AS "orderId"`,
        [afterS, MAX_ORDERS_PER_PASS, sweep.details]
    );

    for (const row of rows) {
        logger.warn({ orderId: row.orderId, type }, 'Incident opened');
    }
    return rows.length;
}

function openKitchenLateIncidents(): Promise<number> {
    return openLateIncidents('kitchen_late');
}

function openDeliveryOverdueIncidents(): Promise<number> {
    return openLateIncidents('delivery_overdue');
}

// The incident-sweep job: both, one after the other.
async function sweepLateOrders(): Promise<number> {
    return (await openKitchenLateIncidents()) + (await openDeliveryOverdueIncidents());
}

export { openKitchenLateIncidents, openDeliveryOverdueIncidents, sweepLateOrders };
