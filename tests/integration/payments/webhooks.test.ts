import { api } from '../../helpers/http';
import { pool } from '../../helpers/db';
import { mockRoute } from '../../helpers/customer';
import { fakeStripe } from '../../helpers/fakeStripe';
import {
    TOTAL, stripeEvent, postEvent, pendingOrder, authorize, decline, orderRow, outboxRows, cartLines,
    statusHistory, expirePaymentWindow,
} from '../../helpers/payments';
import { expirePendingPayments } from '../../../src/services/paymentExpiry';

beforeEach(() => {
    mockRoute(3001);
});

describe('signature', () => {
    it('400 INVALID_SIGNATURE for a payload signed with another secret; nothing changes', async () => {
        const { order, piId } = await pendingOrder();
        const event = stripeEvent('payment_intent.amount_capturable_updated', fakeStripe.authorize(piId));

        const res = await postEvent(event, 'whsec_someone_else');

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_SIGNATURE');
        expect((await orderRow(order.id)).status).toBe('pending_payment');
        const { rows } = await pool.query('SELECT count(*)::int AS n FROM stripe_events');
        expect(rows[0].n).toBe(0);
    });

    it('400 INVALID_SIGNATURE without the Stripe-Signature header', async () => {
        const res = await api().post('/webhooks/stripe').set('Content-Type', 'application/json').send('{}');

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('INVALID_SIGNATURE');
    });
});

describe('T3: card authorized (payment_intent.amount_capturable_updated)', () => {
    it('pending_payment → placed: authorized, placed_at, accept_deadline = placed_at + 300 s, order.placed outbox row', async () => {
        const { order, piId } = await pendingOrder();

        const res = await authorize(order.id, piId);

        expect(res.body).toEqual({ received: true, duplicate: false });
        const row = await orderRow(order.id);
        expect(row).toMatchObject({ status: 'placed', payment_status: 'authorized', last_payment_error: null });
        expect((row.accept_deadline!.getTime() - row.placed_at!.getTime()) / 1000).toBeCloseTo(300, 0);

        const placed = await outboxRows(order.id, 'order.placed');
        expect(placed).toHaveLength(1);
        expect(placed[0].idempotency_key).toBe(`order:${order.id}:placed`);

        expect(await statusHistory(order.id)).toContainEqual(
            expect.objectContaining({ from_status: 'pending_payment', to_status: 'placed', actor: 'system:stripe' })
        );
    });

    it('the same event delivered twice is handled once (duplicate: true, nothing changes)', async () => {
        const { order, piId } = await pendingOrder();
        const event = stripeEvent('payment_intent.amount_capturable_updated', fakeStripe.authorize(piId));

        const first = await postEvent(event);
        const versionAfterFirst = (await orderRow(order.id)).version;
        const second = await postEvent(event);

        expect(first.body.duplicate).toBe(false);
        expect(second.status).toBe(200);
        expect(second.body.duplicate).toBe(true);
        expect((await orderRow(order.id)).version).toBe(versionAfterFirst);
        expect(await outboxRows(order.id, 'order.placed')).toHaveLength(1);
    });

    it('a second, different authorized event for a placed order is a no-op', async () => {
        const { order, piId } = await pendingOrder();
        await authorize(order.id, piId);
        const version = (await orderRow(order.id)).version;

        const res = await authorize(order.id, piId);

        expect(res.body.duplicate).toBe(false);
        expect((await orderRow(order.id)).version).toBe(version);
        expect(await outboxRows(order.id)).toHaveLength(1);
    });

    it('an authorized amount different from the order total never places the order', async () => {
        const { order, piId } = await pendingOrder();

        const res = await postEvent(stripeEvent('payment_intent.amount_capturable_updated', fakeStripe.authorize(piId, TOTAL - 1)));

        expect(res.status).toBe(200);
        expect((await orderRow(order.id)).status).toBe('pending_payment');
        expect(await outboxRows(order.id)).toHaveLength(0);
    });

    it('an event whose PaymentIntent matches no order (or has no orderId) is acknowledged and ignored', async () => {
        const { order, piId } = await pendingOrder();
        const pi = fakeStripe.authorize(piId);

        const wrongOrder = await postEvent(stripeEvent('payment_intent.amount_capturable_updated', { ...pi, metadata: { orderId: '999999' } }));
        const noOrderId = await postEvent(stripeEvent('payment_intent.amount_capturable_updated', { ...pi, metadata: {} }));
        const otherPi = await postEvent(stripeEvent('payment_intent.amount_capturable_updated', { ...pi, id: 'pi_not_ours' }));

        expect([wrongOrder.status, noOrderId.status, otherPi.status]).toEqual([200, 200, 200]);
        expect((await orderRow(order.id)).status).toBe('pending_payment');
    });

    it('an event type without a handler is acknowledged (200) and recorded', async () => {
        const { piId } = await pendingOrder();

        const res = await postEvent(stripeEvent('payment_intent.succeeded', fakeStripe.get(piId), 'evt_unhandled'));

        expect(res.status).toBe(200);
        const { rows } = await pool.query(`SELECT type FROM stripe_events WHERE event_id = 'evt_unhandled'`);
        expect(rows).toEqual([{ type: 'payment_intent.succeeded' }]);
    });
});

describe('T2: card declined (payment_intent.payment_failed)', () => {
    it('decline then success: attempts + 1 and the message, then placed with the error cleared', async () => {
        const { order, customer, piId } = await pendingOrder();

        await decline(piId, 'Your card has insufficient funds.');

        expect(await orderRow(order.id)).toMatchObject({
            status: 'pending_payment',
            payment_attempts: 1,
            last_payment_error: 'Your card has insufficient funds.',
        });
        const view = await api().get(`/orders/${order.id}`).set(customer.headers);
        expect(view.body).toMatchObject({ paymentAttempts: 1, lastPaymentError: 'Your card has insufficient funds.' });

        await authorize(order.id, piId);

        expect(await orderRow(order.id)).toMatchObject({ status: 'placed', payment_attempts: 1, last_payment_error: null });
    });

    it('keeps at most 200 characters of Stripe\'s message', async () => {
        const { order, piId } = await pendingOrder();

        await decline(piId, 'x'.repeat(300));

        expect((await orderRow(order.id)).last_payment_error).toHaveLength(200);
    });

    it('the 5th decline expires the order (too_many_attempts): void queued, cart restored', async () => {
        const { order, customer, shop, piId } = await pendingOrder();

        for (let i = 0; i < 5; i++) {
            expect((await decline(piId)).status).toBe(200);
        }

        expect(await orderRow(order.id)).toMatchObject({
            status: 'expired',
            payment_attempts: 5,
            cancelled_by: 'system',
            cancel_reason: 'too_many_attempts',
            ended_at: expect.any(Date),
        });
        const voids = await outboxRows(order.id, 'payment.void');
        expect(voids).toHaveLength(1);
        expect(voids[0]).toMatchObject({ idempotency_key: `order:${order.id}:void`, payload: { paymentIntentId: piId } });
        expect(await cartLines(customer)).toEqual([{ menuItemId: shop.pizzaId, quantity: 2 }]);
    });

    it('a decline after the order was placed changes nothing', async () => {
        const { order, piId } = await pendingOrder();
        await authorize(order.id, piId);
        const version = (await orderRow(order.id)).version;

        await decline(piId);

        expect(await orderRow(order.id)).toMatchObject({ status: 'placed', payment_attempts: 0, version });
    });
});

describe('late authorization after the order ended → exactly one void', () => {
    it('after expiry (T4)', async () => {
        const { order, piId } = await pendingOrder();
        await expirePaymentWindow(order.id);
        await expirePendingPayments();

        await authorize(order.id, piId);

        expect((await orderRow(order.id)).status).toBe('expired');
        expect(await outboxRows(order.id, 'payment.void')).toHaveLength(1);
        expect(await outboxRows(order.id, 'order.placed')).toHaveLength(0);
    });

    it('after the customer cancelled (T5)', async () => {
        const { order, customer, piId } = await pendingOrder();
        await api().post(`/orders/${order.id}/cancel`).set(customer.headers);

        await authorize(order.id, piId);

        expect((await orderRow(order.id)).status).toBe('cancelled');
        expect(await outboxRows(order.id, 'payment.void')).toHaveLength(1);
    });
});
