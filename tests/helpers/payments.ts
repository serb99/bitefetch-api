import Stripe from 'stripe';
import { pool } from './db';
import { api } from './http';
import { checkout, getCart, readyCart, type Customer } from './customer';
import { fakeStripe, WEBHOOK_SECRET, type FakePaymentIntent } from './fakeStripe';

// readyCart(): 2 x Pizza (800) = 1600; mockRoute(3001) → fee 190 → total 1790
const TOTAL = 1790;

const signer = new Stripe('sk_test_never_used');
let eventSeq = 0;

type EventType =
    | 'payment_intent.amount_capturable_updated'
    | 'payment_intent.payment_failed'
    | 'payment_intent.canceled'
    | 'payment_intent.succeeded';

function stripeEvent(type: EventType, pi: FakePaymentIntent, id = `evt_test_${++eventSeq}`) {
    return {
        id,
        object: 'event',
        api_version: '2025-01-01',
        created: Math.floor(Date.now() / 1000),
        livemode: false,
        pending_webhooks: 1,
        request: { id: null, idempotency_key: null },
        type,
        data: { object: pi },
    };
}

// POSTs the event exactly like Stripe: raw JSON body + Stripe-Signature computed with the secret.
function postEvent(event: object, secret = WEBHOOK_SECRET) {
    const payload = JSON.stringify(event);
    const header = signer.webhooks.generateTestHeaderString({ payload, secret });
    return api().post('/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('Stripe-Signature', header)
        .send(payload);
}

// A customer with a fresh pending_payment order (total 1790) and its fake PaymentIntent.
// The caller must have called mockRoute(3001) (OSRM).
async function pendingOrder() {
    const ready = await readyCart();
    const res = await checkout(ready.customer, TOTAL);
    if (res.status !== 201) {
        throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const order = res.body as { id: string; clientSecret: string | null };
    const row = await orderRow(order.id);
    return { ...ready, order, res, piId: row.stripe_payment_intent_id as string };
}

// The card is accepted at Stripe and Stripe tells us: pending_payment → placed.
async function authorize(orderId: string, piId: string) {
    const res = await postEvent(stripeEvent('payment_intent.amount_capturable_updated', fakeStripe.authorize(piId)));
    if (res.status !== 200) throw new Error(`authorize webhook failed: ${res.status}`);
    return res;
}

function decline(piId: string, message?: string) {
    return postEvent(stripeEvent('payment_intent.payment_failed', fakeStripe.decline(piId, message)));
}

interface OrderRow {
    id: string;
    status: string;
    payment_status: string;
    payment_attempts: number;
    last_payment_error: string | null;
    cancelled_by: string | null;
    cancel_reason: string | null;
    ended_at: Date | null;
    placed_at: Date | null;
    accept_deadline: Date | null;
    stripe_payment_intent_id: string | null;
    capture_attempts: number;
    version: number;
}

async function orderRow(id: string): Promise<OrderRow> {
    const { rows } = await pool.query<OrderRow>(
        `SELECT id, status, payment_status, payment_attempts, last_payment_error, cancelled_by, cancel_reason,
                ended_at, placed_at, accept_deadline, stripe_payment_intent_id, capture_attempts, version
           FROM orders WHERE id = $1`,
        [id]
    );
    return rows[0];
}

interface OutboxRow {
    id: string;
    topic: string;
    idempotency_key: string;
    payload: Record<string, unknown>;
    attempts: number;
    next_attempt_at: Date;
    last_error: string | null;
    processed_at: Date | null;
}

async function outboxRows(orderId: string, topic?: string): Promise<OutboxRow[]> {
    const { rows } = await pool.query<OutboxRow>(
        `SELECT id, topic, idempotency_key, payload, attempts, next_attempt_at, last_error, processed_at
           FROM outbox WHERE order_id = $1 AND ($2::text IS NULL OR topic = $2) ORDER BY id`,
        [orderId, topic ?? null]
    );
    return rows;
}

// Makes every outbox row of the order due now (skips the backoff / lease wait).
async function makeOutboxDue(orderId: string): Promise<void> {
    await pool.query(`UPDATE outbox SET next_attempt_at = now() - interval '1 second' WHERE order_id = $1`, [orderId]);
}

async function expirePaymentWindow(orderId: string): Promise<void> {
    await pool.query(`UPDATE orders SET payment_expires_at = now() - interval '1 second' WHERE id = $1`, [orderId]);
}

async function cartLines(customer: Customer): Promise<{ menuItemId: string; quantity: number }[]> {
    const res = await getCart(customer);
    return res.body.items.map((i: { menuItemId: string; quantity: number }) => ({ menuItemId: i.menuItemId, quantity: i.quantity }));
}

async function statusHistory(orderId: string): Promise<{ from_status: string | null; to_status: string; actor: string }[]> {
    const { rows } = await pool.query(
        `SELECT from_status, to_status, actor FROM order_status_history WHERE order_id = $1 ORDER BY at, id`,
        [orderId]
    );
    return rows;
}

export {
    TOTAL, stripeEvent, postEvent, pendingOrder, authorize, decline, orderRow, outboxRows, makeOutboxDue,
    expirePaymentWindow, cartLines, statusHistory,
};
