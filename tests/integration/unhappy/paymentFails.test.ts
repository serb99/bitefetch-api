import Stripe from 'stripe';
import { mockRoute, checkout } from '../../helpers/customer';
import { fakeStripe } from '../../helpers/fakeStripe';
import {
    TOTAL, pendingOrder, authorize, decline, orderRow, outboxRows, makeOutboxDue, expirePaymentWindow, cartLines,
    stripeEvent, postEvent,
} from '../../helpers/payments';
import { createCourier, pickedUpOrder, setPosition, deliver } from '../../helpers/dispatch';
import { incidentsOf } from '../../helpers/unhappy';
import { expirePendingPayments } from '../../../src/services/paymentExpiry';
import { processPaymentOutbox } from '../../../src/services/paymentOutbox';

// Unhappy path "Payment fails or retried": declined, retry on the same PaymentIntent,
// the same Idempotency-Key, payment window over, a late success, capture fails after delivery.
// Built earlier (tests/integration/payments, worker/reconciliation); here the flow end to end.

beforeEach(() => {
    mockRoute(3001);
});

describe('card declined (the status does not change)', () => {
    it('pending_payment stays, payment_attempts + 1, the error for the customer', async () => {
        const { order, piId } = await pendingOrder();

        await decline(piId, 'Your card was declined.');

        expect(await orderRow(order.id)).toMatchObject({
            status: 'pending_payment', payment_attempts: 1, last_payment_error: 'Your card was declined.',
        });
    });

    it('the 5th failed attempt expires it early (too_many_attempts): one void, the cart is back', async () => {
        const { order, piId, customer, shop } = await pendingOrder();

        for (let i = 0; i < 5; i++) await decline(piId);

        expect(await orderRow(order.id)).toMatchObject({ status: 'expired', cancel_reason: 'too_many_attempts', payment_attempts: 5 });
        expect(await outboxRows(order.id, 'payment.void')).toHaveLength(1);
        expect(await cartLines(customer)).toEqual([{ menuItemId: shop.pizzaId, quantity: 2 }]);
    });
});

describe('retry with another card: the same order and PaymentIntent', () => {
    it('declined 4 times, then authorized → placed', async () => {
        const { order, piId } = await pendingOrder();
        for (let i = 0; i < 4; i++) await decline(piId);

        await authorize(order.id, piId);

        expect(await orderRow(order.id)).toMatchObject({ status: 'placed', payment_status: 'authorized', stripe_payment_intent_id: piId });
        expect(fakeStripe.calls('create')).toHaveLength(1);
    });

    it('a failed webhook arriving after the success is a no-op', async () => {
        const { order, piId } = await pendingOrder();
        await authorize(order.id, piId);

        await postEvent(stripeEvent('payment_intent.payment_failed', fakeStripe.get(piId)));

        expect(await orderRow(order.id)).toMatchObject({ status: 'placed', payment_attempts: 0 });
    });
});

describe('tab closed mid-payment: the app re-sends the saved Idempotency-Key', () => {
    it('200 with the same order and the same PaymentIntent, no second one', async () => {
        const { order, customer } = await pendingOrder();

        const again = await checkout(customer, TOTAL);

        expect(again.status).toBe(200);
        expect(again.body.id).toBe(order.id);
        expect(fakeStripe.calls('create')).toHaveLength(1);
    });
});

describe('the payment window ends, and the authorization lands after it', () => {
    it('expired (payment_window), one void; a late success webhook changes nothing and adds no second void', async () => {
        const { order, piId } = await pendingOrder();
        await expirePaymentWindow(order.id);

        expect(await expirePendingPayments()).toBe(1);
        await authorize(order.id, piId);

        expect(await orderRow(order.id)).toMatchObject({ status: 'expired', cancel_reason: 'payment_window' });
        expect(await outboxRows(order.id, 'payment.void')).toHaveLength(1);
    });
});

describe('capture fails after delivery', () => {
    it('3 automatic attempts (keys :1 :2 :3), then capture_failed + one capture_failed incident; the order stays delivered', async () => {
        const courier = await createCourier();
        const { orderId, door } = await pickedUpOrder(courier);
        await setPosition(courier.id, door);
        expect((await deliver(courier, orderId)).status).toBe(200);
        const refused = () => new Stripe.errors.StripeCardError({ type: 'card_error', message: 'capture refused' });
        fakeStripe.failNext('capture', refused());
        fakeStripe.failNext('capture', refused());
        fakeStripe.failNext('capture', refused());

        for (let i = 0; i < 3; i++) {
            await makeOutboxDue(orderId);
            await processPaymentOutbox();
        }

        expect(fakeStripe.calls('capture').map((c) => c.idempotencyKey)).toEqual([
            `order:${orderId}:capture:1`, `order:${orderId}:capture:2`, `order:${orderId}:capture:3`,
        ]);
        expect(await orderRow(orderId)).toMatchObject({ status: 'delivered', payment_status: 'capture_failed', capture_attempts: 3 });
        expect(await incidentsOf(orderId)).toEqual([
            expect.objectContaining({ type: 'capture_failed', opened_by: 'system', resolved_at: null }),
        ]);
    });

    it('a capture that works the second time: captured, no incident', async () => {
        const courier = await createCourier();
        const { orderId, door } = await pickedUpOrder(courier);
        await setPosition(courier.id, door);
        await deliver(courier, orderId);
        fakeStripe.failNext('capture');

        for (let i = 0; i < 2; i++) {
            await makeOutboxDue(orderId);
            await processPaymentOutbox();
        }

        expect(await orderRow(orderId)).toMatchObject({ payment_status: 'captured', capture_attempts: 2 });
        expect(await incidentsOf(orderId)).toEqual([]);
    });
});
