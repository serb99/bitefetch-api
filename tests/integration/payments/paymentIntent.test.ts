import { api } from '../../helpers/http';
import { mockRoute, checkout, readyCart, createCustomer } from '../../helpers/customer';
import { fakeStripe } from '../../helpers/fakeStripe';
import { TOTAL, pendingOrder, authorize, orderRow } from '../../helpers/payments';

beforeEach(() => {
    mockRoute(3001);
});

describe('PaymentIntent at checkout (POST /orders)', () => {
    it('creates a manual-capture card PaymentIntent for the total and returns its client secret', async () => {
        const { order, piId } = await pendingOrder();

        expect(order.clientSecret).toBe(`${piId}_secret_fake`);
        expect(fakeStripe.get(piId)).toMatchObject({
            amount: TOTAL,
            currency: 'eur',
            capture_method: 'manual',
            metadata: { orderId: order.id },
        });
        expect(fakeStripe.calls('create')).toEqual([{ method: 'create', idempotencyKey: `order:${order.id}:pi` }]);
    });

    it('a checkout replay (same Idempotency-Key) returns the same client secret and makes no second PaymentIntent', async () => {
        const { customer } = await readyCart();

        const first = await checkout(customer, TOTAL, 'same-key');
        const replay = await checkout(customer, TOTAL, 'same-key');

        expect(first.status).toBe(201);
        expect(replay.status).toBe(200);
        expect(replay.body.id).toBe(first.body.id);
        expect(replay.body.clientSecret).toBe(first.body.clientSecret);
        expect(fakeStripe.calls('create')).toHaveLength(1);
    });

    it('Stripe down at checkout: the order is still created (201) with clientSecret null', async () => {
        const { customer } = await readyCart();
        fakeStripe.failNext('create');

        const res = await checkout(customer, TOTAL);

        expect(res.status).toBe(201);
        expect(res.body.clientSecret).toBeNull();
        expect((await orderRow(res.body.id)).stripe_payment_intent_id).toBeNull();
    });

    it('the order view carries the payment fields', async () => {
        const { order, customer } = await pendingOrder();

        const res = await api().get(`/orders/${order.id}`).set(customer.headers);

        expect(res.body).toMatchObject({
            paymentAttempts: 0,
            maxPaymentAttempts: 5,
            lastPaymentError: null,
            cancelReason: null,
        });
        expect(res.body).not.toHaveProperty('clientSecret');
    });
});

describe('GET /orders/:id/payment', () => {
    it('returns the same client secret again (retrieve, no new PaymentIntent)', async () => {
        const { order, customer } = await pendingOrder();

        const res = await api().get(`/orders/${order.id}/payment`).set(customer.headers);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ clientSecret: order.clientSecret });
        expect(fakeStripe.calls('create')).toHaveLength(1);
        expect(fakeStripe.calls('retrieve')).toHaveLength(1);
    });

    it('creates the PaymentIntent when checkout could not (Stripe was down then)', async () => {
        const { customer } = await readyCart();
        fakeStripe.failNext('create');
        const created = await checkout(customer, TOTAL);

        const res = await api().get(`/orders/${created.body.id}/payment`).set(customer.headers);

        expect(res.status).toBe(200);
        const row = await orderRow(created.body.id);
        expect(res.body.clientSecret).toBe(`${row.stripe_payment_intent_id}_secret_fake`);
    });

    it('502 PAYMENT_UNAVAILABLE when Stripe does not answer, without details', async () => {
        const { order, customer } = await pendingOrder();
        fakeStripe.failNext('retrieve');

        const res = await api().get(`/orders/${order.id}/payment`).set(customer.headers);

        expect(res.status).toBe(502);
        expect(res.body.error).toMatchObject({ code: 'PAYMENT_UNAVAILABLE', details: null });
    });

    it('409 ORDER_NOT_PAYABLE once the order is placed', async () => {
        const { order, customer, piId } = await pendingOrder();
        await authorize(order.id, piId);

        const res = await api().get(`/orders/${order.id}/payment`).set(customer.headers);

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('ORDER_NOT_PAYABLE');
    });

    it('404 for another customer\'s order', async () => {
        const { order } = await pendingOrder();
        const other = await createCustomer();

        const res = await api().get(`/orders/${order.id}/payment`).set(other.headers);

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('ORDER_NOT_FOUND');
    });
});
