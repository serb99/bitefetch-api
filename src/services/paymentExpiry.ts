import type { PoolClient } from 'pg';
import { queuePaymentVoid } from './outbox';
import { restoreCartFromOrder } from './cartService';
import { withTransaction } from '../database/transaction';
import { logger } from '../logger';

type ExpireReason = 'payment_window' | 'too_many_attempts';
const MAX_ORDERS_PER_PASS = 50;
type DueOrderRow = { id: string; paymentIntentId: string | null };

// pending_payment → expired, and queue the void of the PaymentIntent (if there is one).
// The caller runs it in its transaction and has locked the order
// false: the order was not pending_payment anymore, nothing changed.
async function expireOrder(
    client: PoolClient,
    orderId: string,
    reason: ExpireReason,
    paymentIntentId: string | null
): Promise<boolean> {
    const result = await client.query<{ customerId: string; restaurantId: string }>(
        `UPDATE orders
            SET status = 'expired',
                ended_at = now(),
                cancelled_by = 'system',
                cancel_reason = $2,
                version = version + 1
          WHERE id = $1 AND status = 'pending_payment'
      RETURNING customer_id AS "customerId", restaurant_id AS "restaurantId"`,
        [orderId, reason]
    );
    const expired = result.rows[0];
    if (!expired) {
        return false;
    }
    // No PaymentIntent (Stripe was down at checkout and the customer never came back): nothing to void.
    if (paymentIntentId) {
        await queuePaymentVoid(client, orderId, paymentIntentId);
    }
    await restoreCartFromOrder(client, expired.customerId, orderId, expired.restaurantId);
    return true;
}

async function expireNextDueOrder(): Promise<boolean> {
    return withTransaction(async (client) => {
        const { rows } = await client.query<DueOrderRow>(
            `SELECT id, stripe_payment_intent_id AS "paymentIntentId"
               FROM orders
              WHERE status = 'pending_payment'
                AND payment_expires_at <= now()
              ORDER BY payment_expires_at
              LIMIT 1
              FOR UPDATE SKIP LOCKED`
        );
        const order = rows[0];
        if (!order) {
            return false;
        }
        await expireOrder(client, order.id, 'payment_window', order.paymentIntentId);
        logger.info({ orderId: order.id }, 'Payment window over, order expired');
        return true;
    }, 'system:expiry', 'payment window over');
}

//  called by the payment timer. Returns how many orders it expired.
async function expirePendingPayments(): Promise<number> {
    let count = 0;
    while (count < MAX_ORDERS_PER_PASS && (await expireNextDueOrder())) {
        count++;
    }
    return count;
}

export { expireOrder, expirePendingPayments};
export type { ExpireReason };