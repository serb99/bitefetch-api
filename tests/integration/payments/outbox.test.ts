import Stripe from 'stripe';
import { api } from '../../helpers/http';
import { pool } from '../../helpers/db';
import { mockRoute } from '../../helpers/customer';
import { fakeStripe, fakeStripeModule } from '../../helpers/fakeStripe';
import { pendingOrder, authorize, orderRow, outboxRows, makeOutboxDue } from '../../helpers/payments';
import { processPaymentOutbox } from '../../../src/services/paymentOutbox';
import { enqueueOutbox } from '../../../src/services/outbox';

beforeEach(() => {
    mockRoute(3001);
});

// A cancelled order with its void row queued (T5).
async function cancelledOrder() {
    const pending = await pendingOrder();
    await api().post(`/orders/${pending.order.id}/cancel`).set(pending.customer.headers);
    return pending;
}

const secondsFromNow = (date: Date) => (date.getTime() - Date.now()) / 1000;

describe('payment.void', () => {
    it('cancels the PaymentIntent at Stripe, marks the order voided and the row processed', async () => {
        const { order, piId } = await cancelledOrder();

        expect(await processPaymentOutbox()).toBe(1);

        expect(fakeStripe.get(piId).status).toBe('canceled');
        expect(fakeStripe.calls('cancel')).toEqual([{ method: 'cancel', id: piId, idempotencyKey: `order:${order.id}:void:1` }]);
        expect((await orderRow(order.id)).payment_status).toBe('voided');
        const [row] = await outboxRows(order.id, 'payment.void');
        expect(row).toMatchObject({ attempts: 1, last_error: null, processed_at: expect.any(Date) });
    });

    it('"already canceled" at Stripe counts as success', async () => {
        const { order, piId } = await cancelledOrder();
        fakeStripe.setStatus(piId, 'canceled');

        expect(await processPaymentOutbox()).toBe(1);

        expect((await orderRow(order.id)).payment_status).toBe('voided');
        expect((await outboxRows(order.id, 'payment.void'))[0].processed_at).not.toBeNull();
    });

    it('releases an authorized hold (late authorization after cancel)', async () => {
        const { order, piId } = await cancelledOrder();
        await authorize(order.id, piId);   // money held after all: 6b queues the same void (still one row)

        await processPaymentOutbox();

        expect(fakeStripe.get(piId).status).toBe('canceled');
        expect((await orderRow(order.id)).payment_status).toBe('voided');
    });

    it('Stripe down: keeps the row with the error and a 30 s backoff, then a later attempt (new Stripe key) succeeds', async () => {
        const { order, piId } = await cancelledOrder();
        fakeStripe.failNext('cancel');

        expect(await processPaymentOutbox()).toBe(1);

        let [row] = await outboxRows(order.id, 'payment.void');
        expect(row).toMatchObject({ attempts: 1, last_error: 'connection lost', processed_at: null });
        expect(secondsFromNow(row.next_attempt_at)).toBeGreaterThan(25);
        expect(secondsFromNow(row.next_attempt_at)).toBeLessThanOrEqual(30);
        expect((await orderRow(order.id)).payment_status).toBe('pending');

        // Not due yet: the next pass leaves it alone.
        expect(await processPaymentOutbox()).toBe(0);

        await makeOutboxDue(order.id);
        expect(await processPaymentOutbox()).toBe(1);

        [row] = await outboxRows(order.id, 'payment.void');
        expect(row).toMatchObject({ attempts: 2, processed_at: expect.any(Date) });
        expect(fakeStripe.get(piId).status).toBe('canceled');
        expect(fakeStripe.calls('cancel').map((c) => c.idempotencyKey)).toEqual([
            `order:${order.id}:void:1`,
            `order:${order.id}:void:2`,
        ]);
    });

    it('the backoff doubles: 30 s, then 60 s', async () => {
        const { order } = await cancelledOrder();
        fakeStripe.failNext('cancel');
        fakeStripe.failNext('cancel');

        await processPaymentOutbox();
        await makeOutboxDue(order.id);
        await processPaymentOutbox();

        const [row] = await outboxRows(order.id, 'payment.void');
        expect(row.attempts).toBe(2);
        expect(secondsFromNow(row.next_attempt_at)).toBeGreaterThan(55);
        expect(secondsFromNow(row.next_attempt_at)).toBeLessThanOrEqual(60);
    });

    it('a row without a paymentIntentId is kept with an error, Stripe is not called', async () => {
        const client = await pool.connect();
        try {
            await enqueueOutbox(client, 'payment.void', '999999', {}, 'order:999999:void');
        } finally {
            client.release();
        }

        expect(await processPaymentOutbox()).toBe(1);

        const [row] = await outboxRows('999999');
        expect(row).toMatchObject({ processed_at: null, last_error: 'payload has no paymentIntentId' });
        expect(fakeStripe.calls('cancel')).toHaveLength(0);
    });
});

describe('the runner', () => {
    it('takes at most 10 rows per pass', async () => {
        const client = await pool.connect();
        try {
            for (let i = 1; i <= 12; i++) {
                const pi = await fakeStripeModule.stripe.paymentIntents.create({ amount: 100, currency: 'eur' });
                await enqueueOutbox(client, 'payment.void', String(900000 + i), { paymentIntentId: pi.id }, `order:${900000 + i}:void`);
            }
        } finally {
            client.release();
        }

        expect(await processPaymentOutbox()).toBe(10);
        expect(await processPaymentOutbox()).toBe(2);
        expect(await processPaymentOutbox()).toBe(0);
    });

    it('never touches order.placed rows (they belong to M10)', async () => {
        const { order, piId } = await pendingOrder();
        await authorize(order.id, piId);

        expect(await processPaymentOutbox()).toBe(0);
        expect((await outboxRows(order.id, 'order.placed'))[0].processed_at).toBeNull();
    });
});

describe('payment.capture (used by T13 in M7)', () => {
    // A placed (not delivered) order: Stripe captures, but the order row only changes once it is delivered.
    async function captureRow() {
        const pending = await pendingOrder();
        await authorize(pending.order.id, pending.piId);
        const client = await pool.connect();
        try {
            await enqueueOutbox(client, 'payment.capture', pending.order.id, { paymentIntentId: pending.piId }, `order:${pending.order.id}:capture`);
        } finally {
            client.release();
        }
        return pending;
    }

    it('captures at Stripe with the key order:{id}:capture:{attempt} and marks the row processed', async () => {
        const { order, piId } = await captureRow();

        expect(await processPaymentOutbox()).toBe(1);

        expect(fakeStripe.get(piId).status).toBe('succeeded');
        expect(fakeStripe.calls('capture')[0].idempotencyKey).toBe(`order:${order.id}:capture:1`);
        expect((await outboxRows(order.id, 'payment.capture'))[0].processed_at).not.toBeNull();
        // Not delivered: the guard keeps payment_status authorized.
        expect((await orderRow(order.id)).payment_status).toBe('authorized');
    });

    it('a failed capture is retried and records capture_attempts; after 3 attempts it gives up (row processed with a note)', async () => {
        const { order } = await captureRow();
        const declined = () => new Stripe.errors.StripeCardError({ type: 'card_error', message: 'capture refused' });
        fakeStripe.failNext('capture', declined());
        fakeStripe.failNext('capture', declined());
        fakeStripe.failNext('capture', declined());

        await processPaymentOutbox();
        expect((await orderRow(order.id)).capture_attempts).toBe(1);
        await makeOutboxDue(order.id);
        await processPaymentOutbox();
        expect((await orderRow(order.id)).capture_attempts).toBe(2);
        await makeOutboxDue(order.id);
        await processPaymentOutbox();

        const [row] = await outboxRows(order.id, 'payment.capture');
        expect(row).toMatchObject({ attempts: 3, processed_at: expect.any(Date), last_error: 'Gave up: capture_failed incident opened' });
    });
});
