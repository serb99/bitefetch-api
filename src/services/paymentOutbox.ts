import { pool } from '../database/pool';
import { logger } from '../logger';
import { voidPayment, capturePayment } from './paymentService';

type PaymentOutboxRow = {
    id: string;
    topic: 'payment.void' | 'payment.capture';
    orderId: string;
    payload: { paymentIntentId?: string };
    attempts: number;
};

const MAX_ROWS_PER_PASS = 10;
const LEASE_S = 120;          // a claimed row stays hidden this long; one row takes at most ~1 min (Stripe timeouts + retries)
const BASE_BACKOFF_S = 30;
const MAX_BACKOFF_S = 3600;

// 30 s, 60 s, 2 min, 4 min ... capped at 1 h
function backoffSeconds(attempts: number): number {
    return Math.min(BASE_BACKOFF_S * 2 ** (attempts - 1), MAX_BACKOFF_S);
}

async function claimNextRow(): Promise<PaymentOutboxRow | null> {
     const { rows } = await pool.query<PaymentOutboxRow>(
        `UPDATE outbox
            SET attempts = attempts + 1,
                next_attempt_at = now() + make_interval(secs => $1)
          WHERE id = (
                SELECT id FROM outbox
                 WHERE processed_at IS NULL
                   AND next_attempt_at <= now()
                   AND topic IN ('payment.void', 'payment.capture')
                 ORDER BY next_attempt_at
                 LIMIT 1
                 FOR UPDATE SKIP LOCKED)
      RETURNING id, topic, order_id AS "orderId", payload, attempts`,
      [LEASE_S]
     );
    return rows[0] ?? null;
}

async function runRow(row: PaymentOutboxRow): Promise<void>{
    try {
        const paymentIntentId = row.payload.paymentIntentId;
        if (!paymentIntentId) {
            throw new Error('payload has no paymentIntentId');
        }

        let note: string | null = null;
        if (row.topic === 'payment.void') {
            await voidPayment(row.orderId, paymentIntentId, row.attempts);
        } else if ((await capturePayment(row.orderId, paymentIntentId, row.attempts)) === 'gave_up'){
            note = 'Gave up: capture_failed incident opened';
        }

        await pool.query(
            `UPDATE outbox SET processed_at = now(), last_error = $2 WHERE id = $1`,
            [row.id, note]
        );
    } catch(err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.warn({ err, outboxId: row.id, orderId: row.orderId, topic: row.topic, attempts: row.attempts }, 'Payment job failed, will retry');
        await pool.query(
            `UPDATE outbox
                SET last_error = $2,
                    next_attempt_at = now() + make_interval(secs => $3)
              WHERE id = $1`,
            [row.id, message.slice(0, 1000), backoffSeconds(row.attempts)]
        );
    }
}

async function processPaymentOutbox(): Promise<number> {
    let count = 0;
    while (count < MAX_ROWS_PER_PASS) {
        const row = await claimNextRow();
        if (!row) break;
        count++;
        try {
            await runRow(row);
        } catch (err) {
            // Only the bookkeeping UPDATE can land here (database down): the lease expires and the row runs again.
            logger.error({ err, outboxId: row.id }, 'Could not record the payment job result');
        }
    }
    return count;
}

export { processPaymentOutbox };