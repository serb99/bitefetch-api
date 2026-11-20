import { pool } from '../database/pool';
import { AppError } from '../errors/AppError';
import { stripe } from './stripeClient';
import { logger } from '../logger';
import Stripe from 'stripe';
import { withTransaction } from '../database/transaction';
import { getNumberSettings } from './settingsService';

type PaymentIntentInfo = { paymentIntentId: string; clientSecret: string };

type OrderPaymentRow = {
    id: string;
    orderCode: string;
    status: string;
    totalMinor: number;
    currency: string;
    paymentIntentId: string | null;
};
type CaptureResult = 'captured' | 'gave_up';

function paymentUnavailable(err: unknown): AppError {
    logger.error({ err }, 'Stripe call failed');
    return new AppError(502, 'PAYMENT_UNAVAILABLE', 'The payment service is not available right now, try again');
}

// Returns the PaymentIntent of an order that still waits for payment, creating it the first time.
// null: the order is past pending_payment, so there is nothing left to pay.
// Called AFTER the checkout transaction commits: no Stripe call ever runs while a row lock is held.
async function ensurePaymentIntent(orderId: string, customerId: string): Promise<PaymentIntentInfo | null> {
    const { rows } = await pool.query<OrderPaymentRow>(
        `SELECT id,
                order_code AS "orderCode",
                status,
                total_minor AS "totalMinor",
                currency,
                stripe_payment_intent_id AS "paymentIntentId"
           FROM orders WHERE id = $1 AND customer_id = $2`,
        [orderId, customerId]
    );
    const order = rows[0];
    if (!order) {
        throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }
    if (order.status !== 'pending_payment') {
        return null;
    }

    let created: Stripe.PaymentIntent;

    try {
        // Already created (a reload, or a checkout replay): ask Stripe for it again.
        // The client secret is not stored in database on purpose.
        if (order.paymentIntentId) {
            const existing = await stripe.paymentIntents.retrieve(order.paymentIntentId);
            return { paymentIntentId: existing.id, clientSecret: existing.client_secret! };
        }

        // First time. The key comes from the order, so a second call (crash before the UPDATE below,
        // two tabs, a replay) gets back the same PaymentIntent instead of a new one.
        created = await stripe.paymentIntents.create({
            amount: order.totalMinor, // cents, as stored
            currency: order.currency.toLowerCase(),      // Stripe wants 'eur'
            capture_method: 'manual',                    // authorize now, capture on delivery
            allowed_payment_method_types: ['card'],
            metadata: { orderId: order.id, orderCode: order.orderCode }
        }, { idempotencyKey: `order:${order.id}:pi` });
    } catch (err) {
        throw paymentUnavailable(err);
    }
    // Only fills an empty column: if a parallel call already saved it, it is this same id anyway.
    await pool.query(
        `UPDATE orders SET stripe_payment_intent_id = $2
            WHERE id = $1 AND stripe_payment_intent_id IS NULL`,
        [order.id, created.id]
    );

    return { paymentIntentId: created.id, clientSecret: created.client_secret! };
}

async function isAlreadyInStatus(
    err: unknown,
    paymentIntentId: string,
    status: Stripe.PaymentIntent.Status
): Promise<boolean> {
    if (!(err instanceof Stripe.errors.StripeError) || err.code !== 'payment_intent_unexpected_state') {
        return false;
    }
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    return pi.status === status;
}

// Releases the hold (or closes an unpaid PaymentIntent) and records it.
// Called by the outbox runner, never inside a transaction. Throws on failure: the runner retries later.
// attempt: 1, 2, 3... one Stripe idempotency key per attempt.
async function voidPayment(orderId: string, paymentIntentId: string, attempt: number): Promise<void> {
    try{
        await stripe.paymentIntents.cancel(paymentIntentId, {}, { idempotencyKey: `order:${orderId}:void:${attempt}` });
    } catch (err) {
        if (!(await isAlreadyInStatus(err, paymentIntentId, 'canceled'))) {
            throw err;
        }
        logger.info({ orderId, paymentIntentId }, 'PaymentIntent was already canceled');
    }

    // Only after Stripe confirmed. pending (never paid) or authorized (hold released) → voided.
    await pool.query(
        `UPDATE orders
            SET payment_status = 'voided',
                version = version + 1
          WHERE id = $1 AND payment_status IN ('pending', 'authorized')`,
        [orderId]
    );
}

// Last automatic attempt failed: the order stays delivered, the admin takes over 
async function markCaptureFailed(orderId: string, attempts: number, err: unknown): Promise<void>{
    logger.error({ err, orderId, attempts }, 'Capture failed, incident opened');
    const reason = err instanceof Error ? err.message : 'unknown error';

     await withTransaction(async (client) => {
        const { rows } = await client.query<{ restaurantId: string }>(
            `UPDATE orders
                SET payment_status = 'capture_failed',
                    capture_attempts = $2,
                    version = version + 1
              WHERE id = $1 AND status = 'delivered' AND payment_status = 'authorized'
              RETURNING restaurant_id AS "restaurantId"`,
              [orderId, attempts]
        );
        if (!rows[0]) return;

        // One open capture_failed incident per order
        await client.query(
            `INSERT INTO order_incidents (order_id, restaurant_id, type, opened_by, details)
             VALUES ($1, $2, 'capture_failed', 'system', $3)
             ON CONFLICT (order_id, type) WHERE resolved_at IS NULL AND order_id IS NOT NULL DO NOTHING`,
            [orderId, rows[0].restaurantId, `Capture failed after ${attempts} attempts: ${reason}`.slice(0, 1000)]
        );
     }, 'system:payments', 'capture_failed');
}

// Takes the held money. Called by the outbox runner
async function capturePayment(orderId: string, paymentIntentId: string, attempt: number): Promise<CaptureResult>{
    const settings = await getNumberSettings(['capture_auto_retries'] as const);

    try {
         await stripe.paymentIntents.capture(paymentIntentId, {}, { idempotencyKey: `order:${orderId}:capture:${attempt}` });
    } catch (err) {
        if (!(await isAlreadyInStatus(err, paymentIntentId, 'succeeded'))) {
            if (attempt >= settings.capture_auto_retries) {
                await markCaptureFailed(orderId, attempt, err);
                return 'gave_up';
            }
            await pool.query(`UPDATE orders SET capture_attempts = $2 WHERE id = $1`, [orderId, attempt]);
            throw err;
        }
        logger.info({ orderId, paymentIntentId }, 'PaymentIntent was already captured');
    }
     await pool.query(
        `UPDATE orders
            SET payment_status = 'captured',
                capture_attempts = $2,
                version = version + 1
          WHERE id = $1 AND status = 'delivered' AND payment_status IN ('authorized', 'capture_failed')`,
        [orderId, attempt]
    );
    return 'captured';
}

export { ensurePaymentIntent, voidPayment, capturePayment };
export type { PaymentIntentInfo, CaptureResult };