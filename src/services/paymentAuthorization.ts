import type Stripe from 'stripe';
import type { PoolClient } from 'pg';
import { logger } from '../logger';
import { enqueueOutbox, queuePaymentVoid } from './outbox';

type AuthorizedOrder = { id: string; status: string; totalMinor: number };
type AuthorizedPayment = Pick<Stripe.PaymentIntent, 'id' | 'amount_capturable'>;
type AuthorizationOutcome = 'placed' | 'voided_late' | 'not_pending' | 'amount_mismatch';

// The card is authorized (money blocked, not taken) → placed.
// Shared by the Stripe webhook and the reconciliation sweeper, so both follow exactly the same rules.
// The caller has locked the order row (FOR UPDATE) in `client`'s transaction and read the settings before the lock.
async function placeAuthorizedOrder(
    client: PoolClient,
    order: AuthorizedOrder,
    pi: AuthorizedPayment,
    acceptWindowS: number
): Promise<AuthorizationOutcome> {
    // Too late: the order already ended while the customer was paying. Give the money back.
    if (order.status === 'expired' || order.status === 'cancelled') {
        await queuePaymentVoid(client, order.id, pi.id);
        logger.info({ orderId: order.id, status: order.status }, 'Late authorization, void queued');
        return 'voided_late';
    }
    // Already placed (or further): the other path got here first. Nothing to do.
    if (order.status !== 'pending_payment') {
        return 'not_pending';
    }

    // Stripe blocked a different amount than the order total: never place it.
    if (pi.amount_capturable !== order.totalMinor) {
        logger.error(
            { orderId: order.id, amountCapturable: pi.amount_capturable, totalMinor: order.totalMinor },
            'Authorized amount does not match the order total'
        );
        return 'amount_mismatch';
    }

    await client.query(
        `UPDATE orders
            SET status = 'placed',
                payment_status = 'authorized',
                placed_at = now(),
                accept_deadline = now() + make_interval(secs => $2),
                last_payment_error = NULL,
                version = version + 1
          WHERE id = $1`,
        [order.id, acceptWindowS]
    );
    await enqueueOutbox(client, 'order.placed', order.id, { orderId: order.id }, `order:${order.id}:placed`);
    return 'placed';
}

export { placeAuthorizedOrder };
export type { AuthorizedOrder, AuthorizationOutcome };