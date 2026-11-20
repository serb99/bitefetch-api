import type { PoolClient } from 'pg';

type OutboxTopic = 'payment.void' | 'payment.capture' | 'order.placed';

// Queues a side effect inside the caller's transaction: it exists only if the state change commits.
// Same idempotency key twice = one row; returns false when the row was already there.
async function enqueueOutbox(
    client: PoolClient,
    topic: OutboxTopic,
    orderId: string,
    payload: Record<string, unknown>,
    idempotencyKey: string
): Promise<boolean> {
    const result = await client.query(
        `INSERT INTO outbox (topic, order_id, payload, idempotency_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [topic, orderId, payload, idempotencyKey]
    );
    return result.rowCount === 1;
}

// Every cancel path calls this. One void per order, however many paths ask for it.
function queuePaymentVoid(client: PoolClient, orderId: string, paymentIntentId: string): Promise<boolean> {
    return enqueueOutbox(client, 'payment.void', orderId, { paymentIntentId }, `order:${orderId}:void`);
}

export { enqueueOutbox, queuePaymentVoid };
export type { OutboxTopic };