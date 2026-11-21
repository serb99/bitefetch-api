import type { PoolClient } from 'pg';
import { withTransaction } from '../database/transaction';
import { logger } from '../logger';
import { queuePaymentVoid } from './outbox';
import { AUTO_PAUSE_TIMEOUTS } from './restaurantService';

const MAX_ORDERS_PER_PASS = 50;
const AUTO_PAUSE_DAYS = 30;

type TimedOutRow = { id: string; restaurantId: string; paymentIntentId: string | null };

async function countMissedOrder(client: PoolClient, restaurantId: string, orderId: string): Promise<boolean>{
    const { rows } = await client.query<{ missed: number }>(
        `UPDATE restaurants
            SET consecutive_timeouts = consecutive_timeouts + 1,
                paused_until = CASE
                    WHEN consecutive_timeouts + 1 >= $2 THEN now() + make_interval(days => $3)
                    ELSE paused_until
                END,
                version = version + 1
          WHERE id = $1
      RETURNING consecutive_timeouts AS missed`,
      [restaurantId, AUTO_PAUSE_TIMEOUTS, AUTO_PAUSE_DAYS]
    );
    const missed = rows[0].missed;
    if (missed < AUTO_PAUSE_TIMEOUTS) {
        return false;
    }

    // // One open restaurant_unresponsive incident per restaurant
    await client.query(
        `INSERT INTO order_incidents (restaurant_id, type, opened_by, details)
         VALUES ($1, 'restaurant_unresponsive', 'system', $2)
         ON CONFLICT (restaurant_id) WHERE resolved_at IS NULL AND type = 'restaurant_unresponsive'
         DO NOTHING`,
        [restaurantId, `${missed} orders in a row not answered (last: order ${orderId})`]
    );
    return true;
}

async function rejectNextTimedOutOrder(): Promise<boolean> {
    return withTransaction(async (client) => {
        const { rows } = await client.query<TimedOutRow>(
            `SELECT id,
                    restaurant_id AS "restaurantId",
                    stripe_payment_intent_id AS "paymentIntentId"
               FROM orders
              WHERE status = 'placed'
                AND accept_deadline <= now()
              ORDER BY accept_deadline
              LIMIT 1
              FOR UPDATE SKIP LOCKED`
        );
        const order = rows[0];
        if (!order) {
            return false;
        }

        await client.query(
            `UPDATE orders
                SET status = 'rejected',
                    cancelled_by = 'system',
                    cancel_reason = 'restaurant_timeout',
                    ended_at = now(),
                    version = version + 1
              WHERE id = $1`,
            [order.id]
        );
        if (order.paymentIntentId) {
            await queuePaymentVoid(client, order.id, order.paymentIntentId);
        }
        const paused = await countMissedOrder(client, order.restaurantId, order.id);

        logger.info({ orderId: order.id, restaurantId: order.restaurantId, paused }, 'Restaurant did not answer, order rejected');
        return true;
    }, 'system:accept-timeout', 'restaurant did not answer in time');
}

// Called by the 5 s timer. Returns how many orders it rejected.
async function rejectTimedOutOrders(): Promise<number> {
    let count = 0;
    while (count < MAX_ORDERS_PER_PASS && (await rejectNextTimedOutOrder())) {
        count++;
    }
    return count;
}

export { rejectTimedOutOrders };