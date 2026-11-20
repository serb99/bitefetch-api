import { pool } from '../../helpers/db';
import { mockRoute, checkout, readyCart } from '../../helpers/customer';
import { fakeStripe } from '../../helpers/fakeStripe';
import {
    TOTAL, pendingOrder, authorize, orderRow, outboxRows, cartLines, statusHistory, expirePaymentWindow,
} from '../../helpers/payments';
import { expirePendingPayments } from '../../../src/services/paymentExpiry';

beforeEach(() => {
    mockRoute(3001);
});

describe('T4: expirePendingPayments()', () => {
    it('expires an order whose payment window is over: system, payment_window, void queued, cart restored', async () => {
        const { order, customer, shop, piId } = await pendingOrder();
        await expirePaymentWindow(order.id);

        expect(await expirePendingPayments()).toBe(1);

        expect(await orderRow(order.id)).toMatchObject({
            status: 'expired',
            cancelled_by: 'system',
            cancel_reason: 'payment_window',
            ended_at: expect.any(Date),
        });
        const voids = await outboxRows(order.id, 'payment.void');
        expect(voids).toHaveLength(1);
        expect(voids[0].payload).toEqual({ paymentIntentId: piId });
        expect(await cartLines(customer)).toEqual([{ menuItemId: shop.pizzaId, quantity: 2 }]);
        expect(await statusHistory(order.id)).toContainEqual(
            expect.objectContaining({ from_status: 'pending_payment', to_status: 'expired', actor: 'system:expiry' })
        );
    });

    it('leaves orders that still have time, and orders already placed', async () => {
        const waiting = await pendingOrder();
        const placed = await pendingOrder();
        await authorize(placed.order.id, placed.piId);
        await expirePaymentWindow(placed.order.id);

        expect(await expirePendingPayments()).toBe(0);

        expect((await orderRow(waiting.order.id)).status).toBe('pending_payment');
        expect((await orderRow(placed.order.id)).status).toBe('placed');
    });

    it('an order without a PaymentIntent expires without a void', async () => {
        const { customer } = await readyCart();
        fakeStripe.failNext('create');
        const created = await checkout(customer, TOTAL);
        await expirePaymentWindow(created.body.id);

        expect(await expirePendingPayments()).toBe(1);

        expect((await orderRow(created.body.id)).status).toBe('expired');
        expect(await outboxRows(created.body.id)).toHaveLength(0);
    });

    it('skips an order another transaction holds (SKIP LOCKED) and takes it on the next pass', async () => {
        const { order } = await pendingOrder();
        await expirePaymentWindow(order.id);

        const holder = await pool.connect();
        try {
            await holder.query('BEGIN');
            await holder.query('SELECT id FROM orders WHERE id = $1 FOR UPDATE', [order.id]);

            expect(await expirePendingPayments()).toBe(0);

            await holder.query('ROLLBACK');
        } finally {
            holder.release();
        }

        expect(await expirePendingPayments()).toBe(1);
        expect((await orderRow(order.id)).status).toBe('expired');
    });

    it('runs again safely: an expired order is never expired twice', async () => {
        const { order } = await pendingOrder();
        await expirePaymentWindow(order.id);
        await expirePendingPayments();
        const version = (await orderRow(order.id)).version;

        expect(await expirePendingPayments()).toBe(0);
        expect((await orderRow(order.id)).version).toBe(version);
    });
});
