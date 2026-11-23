import type Stripe from 'stripe';
import { pool } from '../database/pool';
import { withTransaction } from '../database/transaction';
import { logger } from '../logger';
import { stripe } from './stripeClient';
import { getNumberSettings } from './settingsService';
import { placeAuthorizedOrder, type AuthorizedOrder } from './paymentAuthorization';
import { expireOrder } from './paymentExpiry';

const MAX_ORDERS_PER_PASS = 20;

type CandidateRow = { id: string; paymentIntentId: string };

async function reconcileOrder(orderId: string, pi: Stripe.PaymentIntent, acceptWindowS: number): Promise<boolean> {
    return withTransaction(async (client) => {
        const { rows } = await client.query<AuthorizedOrder>(
            `SELECT id, status, total_minor AS "totalMinor"
               FROM orders
              WHERE id = $1 AND stripe_payment_intent_id = $2
              FOR UPDATE SKIP LOCKED`,
            [orderId, pi.id]
        );
        const order = rows[0];
        if (!order) {
            return false;
        }

        if (pi.status === 'requires_capture') {
            const outcome = await placeAuthorizedOrder(client, order, pi, acceptWindowS);
            if (outcome === 'placed') {
                logger.warn({ orderId, paymentIntentId: pi.id }, 'Reconciliation placed an order (webhook missing)');
            }
            return outcome === 'placed';
        }

        // canceled at Stripe while we still wait for payment: the order cannot be paid any more
        const expired = await expireOrder(client, order.id, 'payment_window', pi.id);
        if (expired) {
            logger.warn({ orderId, paymentIntentId: pi.id }, 'Reconciliation expired an order (PaymentIntent canceled)');
        }
        return expired;
    }, 'system:reconcile', `stripe says ${pi.status}`);
}

async function reconcilePendingPayments(): Promise<number> {
    const settings = await getNumberSettings(['reconcile_after_s', 'accept_window_s'] as const);

    const { rows } = await pool.query<CandidateRow>(
        `SELECT id, stripe_payment_intent_id AS "paymentIntentId"
           FROM orders
          WHERE status = 'pending_payment'
            AND stripe_payment_intent_id IS NOT NULL
            AND created_at <= now() - make_interval(secs => $1)
          ORDER BY created_at
          LIMIT $2`,
        [settings.reconcile_after_s, MAX_ORDERS_PER_PASS]
    );

    let changed = 0;
    for (const candidate of rows) {
        let pi: Stripe.PaymentIntent;
        try {
            pi = await stripe.paymentIntents.retrieve(candidate.paymentIntentId);
        } catch (err) {
            // Stripe is down: the other orders would fail the same way. Stop and try again next minute.
            logger.warn({ err, orderId: candidate.id }, 'Reconciliation: Stripe unavailable, pass stopped');
            break;
        }

        if (pi.status !== 'requires_capture' && pi.status !== 'canceled') {
            continue; // still in progress at Stripe: nothing to fix
        }
        if (await reconcileOrder(candidate.id, pi, settings.accept_window_s)) {
            changed++;
        }
    }
    return changed;
}

export { reconcilePendingPayments };