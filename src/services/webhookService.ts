import type Stripe from 'stripe';
import type { PoolClient } from 'pg';
import { withTransaction } from '../database/transaction';
import { logger } from '../logger';
import { enqueueOutbox, queuePaymentVoid } from './outbox';
import { getNumberSettings } from './settingsService';
import { expireOrder } from './paymentExpiry';

type EventHandler = (client: PoolClient, event: Stripe.Event) => Promise<void>;
type LockedOrderRow = {
    id: string;
    status: string;
    totalMinor: number;
    paymentAttempts: number;
};

// One handler per event type, all running inside the same transaction as the dedupe insert.
const handlers: Partial<Record<Stripe.Event.Type, EventHandler>> = {
    'payment_intent.amount_capturable_updated': onAuthorized,
    'payment_intent.payment_failed': onPaymentFailed
};

function paymentIntentIdOf(event: Stripe.Event): string | null {
    const obj = event.data.object as { object?: string; id?: string };
    return obj.object === 'payment_intent' ? (obj.id ?? null) : null;
}

async function handleStripeEvent(event: Stripe.Event):  Promise<'processed' | 'duplicate'> {
    return withTransaction(async (client) => {
        // Dedupe first. Same transaction as the state change: if the handler fails, this row
        // rolls back too, and Stripe's retry is processed normally.
        const inserted = await client.query(
            `INSERT INTO stripe_events (event_id, type, payment_intent_id)
             VALUES ($1, $2, $3)
             ON CONFLICT (event_id) DO NOTHING`,
             [event.id, event.type, paymentIntentIdOf(event)]
        );
         if (inserted.rowCount === 0) {
            return 'duplicate';
        }

        const handler = handlers[event.type];
        if (handler) {
            await handler(client, event);
        } else {
            logger.info({ eventId: event.id, type: event.type }, 'Stripe event ignored (no handler)');
        }
        return 'processed';
    }, 'system:stripe', `webhook:${event.type}`);
}

// Finds and locks the order a PaymentIntent event belongs to.
// null: not one of our orders (already logged); the caller returns normally, so Stripe gets 200 and stops.
async function lockOrderOfEvent(
    client: PoolClient,
    event: Stripe.Event
): Promise<{ pi: Stripe.PaymentIntent; order: LockedOrderRow } | null> {
    const pi = event.data.object as Stripe.PaymentIntent;
    const orderId = pi.metadata?.orderId;

    if (!orderId || !/^\d+$/.test(orderId)) {
        logger.warn({ eventId: event.id, type: event.type, paymentIntentId: pi.id }, 'PaymentIntent without a valid orderId');
        return null;
    }

     const { rows } = await client.query<LockedOrderRow>(
        `SELECT id,
                status,
                total_minor AS "totalMinor",
                payment_attempts AS "paymentAttempts"
           FROM orders
          WHERE id = $1 AND stripe_payment_intent_id = $2
          FOR UPDATE`,
        [orderId, pi.id]
    );
    const order = rows[0];
    if (!order) {
        logger.error({ eventId: event.id, type: event.type, orderId, paymentIntentId: pi.id }, 'PaymentIntent matches no order');
        return null;
    }
    return { pi, order };
}

// the card is authorized (money blocked, not taken). pending_payment → placed.
async function onAuthorized(client: PoolClient, event: Stripe.Event): Promise<void> {
     // Read before the lock: keeps the row lock short.
    const settings = await getNumberSettings(['accept_window_s'] as const);

    const found = await lockOrderOfEvent(client, event);
    if (!found) return;
    const { pi, order } = found;

    // Too late: the order already ended while the customer was paying. Give the money back.
    if (order.status === 'expired' || order.status === 'cancelled') {
        await queuePaymentVoid(client, order.id, pi.id);
        logger.info({ orderId: order.id, status: order.status }, 'Late authorization, void queued');
        return;
    }

    if (order.status !== 'pending_payment') {
        return;
    }
    // Stripe blocked a different amount than the order total: never place it.
    if (pi.amount_capturable !== order.totalMinor) {
        logger.error(
            { orderId: order.id, amountCapturable: pi.amount_capturable, totalMinor: order.totalMinor },
            'Authorized amount does not match the order total'
        );
        return;
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
          [order.id, settings.accept_window_s]
    );
    await enqueueOutbox(client, 'order.placed', order.id, { orderId: order.id }, `order:${order.id}:placed`);
}

// A card attempt was declined. The PaymentIntent stays usable: the customer can try another card.
// pending_payment → pending_payment; at the last allowed attempt → expired
async function onPaymentFailed(client: PoolClient, event: Stripe.Event): Promise<void> {
    // Read before the lock: keeps the row lock short.
    const settings = await getNumberSettings(['max_payment_attempts'] as const);

    const found = await lockOrderOfEvent(client, event);
    if (!found) return;
    const { pi, order } = found;

    // Only while waiting for payment: a failure after success, expiry or cancel changes nothing.
    if (order.status !== 'pending_payment') {
        return;
    }

    const attempts = order.paymentAttempts + 1;
    // Stripe's message is written for the customer ("Your card has insufficient funds."). Column is varchar(200).
    const message = (pi.last_payment_error?.message ?? 'The payment failed').slice(0, 200);

    await client.query(
        `UPDATE orders
            SET payment_attempts = $2,
                last_payment_error = $3,
                version = version + 1
          WHERE id = $1`,
        [order.id, attempts, message]
    );

    if (attempts >= settings.max_payment_attempts) {
        await expireOrder(client, order.id, 'too_many_attempts', pi.id);
        logger.info({ orderId: order.id, attempts }, 'Too many failed payment attempts, order expired');
    }
}

export { handleStripeEvent };