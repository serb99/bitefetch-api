import { pool } from '../../helpers/db';
import { mockRoute } from '../../helpers/customer';
import { fakeStripe, fakeStripeModule } from '../../helpers/fakeStripe';
import { orderRow, outboxRows } from '../../helpers/payments';
import { createCourier, deliver, pickedUpOrder, setPosition } from '../../helpers/dispatch';
import { processPaymentOutbox } from '../../../src/services/paymentOutbox';

// M8 DoD: "killing and restarting the worker mid-run loses no events and double-processes none".
// A worker claims an outbox row (attempts + 1, hidden for the 120 s lease) and dies before marking it done.
// After the lease, the next worker takes the row again, and the money is still taken exactly once.

beforeEach(() => {
    mockRoute(3001);
});

// A delivered order: its payment.capture row is waiting in the outbox.
async function deliveredOrder() {
    const courier = await createCourier();
    const order = await pickedUpOrder(courier);
    await setPosition(courier.id, order.door);
    const res = await deliver(courier, order.orderId);
    if (res.status !== 200) throw new Error(`deliver failed: ${res.status}`);
    const [capture] = await outboxRows(order.orderId, 'payment.capture');
    return { ...order, captureRowId: capture.id };
}

// What claimNextRow did before the worker died: attempts 1, hidden until the lease ends.
async function leasedByDeadWorker(rowId: string): Promise<void> {
    await pool.query(
        `UPDATE outbox SET attempts = 1, next_attempt_at = now() + interval '120 seconds' WHERE id = $1`,
        [rowId]
    );
}

async function leaseEnds(rowId: string): Promise<void> {
    await pool.query(`UPDATE outbox SET next_attempt_at = now() - interval '1 second' WHERE id = $1`, [rowId]);
}

it('died BEFORE calling Stripe: hidden during the lease, captured once after it', async () => {
    const { orderId, piId, captureRowId } = await deliveredOrder();
    await leasedByDeadWorker(captureRowId);

    expect(await processPaymentOutbox()).toBe(0); // the restarted worker cannot see the leased row yet
    expect(fakeStripe.calls('capture')).toHaveLength(0);

    await leaseEnds(captureRowId);
    expect(await processPaymentOutbox()).toBe(1);

    expect(fakeStripe.calls('capture')).toEqual([
        { method: 'capture', id: piId, idempotencyKey: `order:${orderId}:capture:2` },
    ]);
    expect(fakeStripe.get(piId).status).toBe('succeeded');
    expect((await orderRow(orderId)).payment_status).toBe('captured');
    const [row] = await outboxRows(orderId, 'payment.capture');
    expect(row.processed_at).not.toBeNull();
    expect(row.attempts).toBe(2);
});

it('died AFTER Stripe captured but before recording it: the retry sees "already captured", no second charge', async () => {
    const { orderId, piId, captureRowId } = await deliveredOrder();
    await leasedByDeadWorker(captureRowId);
    // The dead worker's Stripe call went through
    await fakeStripeModule.stripe.paymentIntents.capture(piId, {}, { idempotencyKey: `order:${orderId}:capture:1` });

    await leaseEnds(captureRowId);
    expect(await processPaymentOutbox()).toBe(1);

    // The second capture call was refused by Stripe (the PaymentIntent is already succeeded): money taken once
    expect(fakeStripe.calls('capture')).toHaveLength(2);
    expect(fakeStripe.get(piId).status).toBe('succeeded');
    expect((await orderRow(orderId)).payment_status).toBe('captured');
    const [row] = await outboxRows(orderId, 'payment.capture');
    expect(row.processed_at).not.toBeNull();
    expect(row.last_error).toBeNull();
});

it('two workers after the lease: the row is run once', async () => {
    const { orderId, captureRowId } = await deliveredOrder();
    await leasedByDeadWorker(captureRowId);
    await leaseEnds(captureRowId);

    const counts = await Promise.all([processPaymentOutbox(), processPaymentOutbox()]);

    expect(counts[0] + counts[1]).toBe(1);
    expect(fakeStripe.calls('capture')).toHaveLength(1);
    expect((await orderRow(orderId)).payment_status).toBe('captured');
});
