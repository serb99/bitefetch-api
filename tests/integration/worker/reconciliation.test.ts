import { mockRoute } from '../../helpers/customer';
import { fakeStripe } from '../../helpers/fakeStripe';
import {
    TOTAL, cartLines, orderRow, outboxRows, pendingOrder, postEvent, statusHistory, stripeEvent,
} from '../../helpers/payments';
import { ageOrder } from '../../helpers/worker';
import { reconcilePendingPayments } from '../../../src/services/paymentReconciliation';
import { getNumberSettings } from '../../../src/services/settingsService';

// M8 reconciliation: pending_payment orders older than reconcile_after_s are checked at Stripe directly.
// requires_capture → T3 (placed, same rules as the webhook), canceled → T4 (expired), anything else → untouched.

let olderThanS: number;

beforeEach(async () => {
    mockRoute(3001);
    olderThanS = (await getNumberSettings(['reconcile_after_s'] as const)).reconcile_after_s + 10;
});

// A pending order whose webhook never came: the card is authorized at Stripe only.
async function lostWebhookOrder() {
    const pending = await pendingOrder();
    await ageOrder(pending.order.id, olderThanS);
    return pending;
}

describe('requires_capture (the webhook was lost)', () => {
    it('placed, with accept_deadline, the order.placed outbox row and actor system:reconcile', async () => {
        const { order, piId } = await lostWebhookOrder();
        fakeStripe.authorize(piId);

        expect(await reconcilePendingPayments()).toBe(1);

        const row = await orderRow(order.id);
        expect(row).toMatchObject({ status: 'placed', payment_status: 'authorized' });
        expect(row.placed_at).not.toBeNull();
        expect(row.accept_deadline).not.toBeNull();
        expect(await outboxRows(order.id, 'order.placed')).toHaveLength(1);
        expect((await statusHistory(order.id)).at(-1)).toMatchObject({
            from_status: 'pending_payment',
            to_status: 'placed',
            actor: 'system:reconcile',
        });
    });

    it('a different authorized amount: stays pending_payment', async () => {
        const { order, piId } = await lostWebhookOrder();
        fakeStripe.authorize(piId, TOTAL - 1);

        expect(await reconcilePendingPayments()).toBe(0);

        expect((await orderRow(order.id)).status).toBe('pending_payment');
    });

    it('reconciliation and the webhook at the same moment: one T3, one order.placed row', async () => {
        const { order, piId } = await lostWebhookOrder();
        const pi = fakeStripe.authorize(piId);

        const [, webhook] = await Promise.all([
            reconcilePendingPayments(),
            postEvent(stripeEvent('payment_intent.amount_capturable_updated', pi)),
        ]);

        expect(webhook.status).toBe(200);
        expect((await orderRow(order.id)).status).toBe('placed');
        expect(await outboxRows(order.id, 'order.placed')).toHaveLength(1);
        expect((await statusHistory(order.id)).filter((h) => h.to_status === 'placed')).toHaveLength(1);
    });
});

describe('canceled at Stripe', () => {
    it('expired (payment_window), the cart is restored and one void is queued', async () => {
        const { order, piId, customer, shop } = await lostWebhookOrder();
        fakeStripe.setStatus(piId, 'canceled');

        expect(await reconcilePendingPayments()).toBe(1);

        expect(await orderRow(order.id)).toMatchObject({
            status: 'expired',
            cancel_reason: 'payment_window',
            cancelled_by: 'system',
        });
        expect(await cartLines(customer)).toEqual([{ menuItemId: shop.pizzaId, quantity: 2 }]);
        expect(await outboxRows(order.id, 'payment.void')).toHaveLength(1);
        expect((await statusHistory(order.id)).at(-1)).toMatchObject({ to_status: 'expired', actor: 'system:reconcile' });
    });
});

describe('left alone', () => {
    it('younger than reconcile_after_s: not selected, Stripe is not asked', async () => {
        const { order, piId } = await pendingOrder();
        fakeStripe.authorize(piId);

        expect(await reconcilePendingPayments()).toBe(0);

        expect((await orderRow(order.id)).status).toBe('pending_payment');
        expect(fakeStripe.calls('retrieve')).toHaveLength(0);
    });

    it.each(['requires_payment_method', 'requires_action', 'processing'] as const)(
        '%s (the customer is still paying): untouched',
        async (status) => {
            const { order, piId } = await lostWebhookOrder();
            fakeStripe.setStatus(piId, status);

            expect(await reconcilePendingPayments()).toBe(0);

            expect((await orderRow(order.id)).status).toBe('pending_payment');
            expect(fakeStripe.calls('retrieve')).toHaveLength(1);
        }
    );

    it('already placed by the webhook: no longer a candidate', async () => {
        const { order, piId } = await lostWebhookOrder();
        await postEvent(stripeEvent('payment_intent.amount_capturable_updated', fakeStripe.authorize(piId)));

        expect(await reconcilePendingPayments()).toBe(0);

        expect(fakeStripe.calls('retrieve')).toHaveLength(0);
        expect((await statusHistory(order.id)).filter((h) => h.to_status === 'placed')).toHaveLength(1);
    });
});

describe('limits', () => {
    it('Stripe unavailable: the pass stops at the first failed call and changes nothing', async () => {
        const first = await lostWebhookOrder();
        const second = await lostWebhookOrder();
        fakeStripe.authorize(first.piId);
        fakeStripe.authorize(second.piId);
        fakeStripe.failNext('retrieve');

        expect(await reconcilePendingPayments()).toBe(0);

        expect(fakeStripe.calls('retrieve')).toHaveLength(1);
        expect((await orderRow(first.order.id)).status).toBe('pending_payment');
        expect((await orderRow(second.order.id)).status).toBe('pending_payment');

        // next pass: Stripe is back
        expect(await reconcilePendingPayments()).toBe(2);
    });

    it('at most 20 orders per pass, the oldest first', async () => {
        const orders = [];
        for (let i = 0; i < 21; i++) {
            const pending = await pendingOrder();
            await ageOrder(pending.order.id, olderThanS + (21 - i)); // the first one is the oldest
            fakeStripe.authorize(pending.piId);
            orders.push(pending);
        }

        expect(await reconcilePendingPayments()).toBe(20);

        expect((await orderRow(orders[20].order.id)).status).toBe('pending_payment');
        expect((await orderRow(orders[0].order.id)).status).toBe('placed');
        expect(await reconcilePendingPayments()).toBe(1);
    }, 30_000);
});
