import { api } from '../../helpers/http';
import { mockRoute } from '../../helpers/customer';
import { outboxRows, cartLines } from '../../helpers/payments';
import {
    placedOrder, acceptedOrder, customerCancel, ready, kitchenRow, historyWithReason,
} from '../../helpers/restaurantOrders';

// T9: POST /orders/:id/cancel while placed (paid, the restaurant has not answered yet).
// T5 (while pending_payment) is in payments/cancel.test.ts.

beforeEach(() => {
    mockRoute(3001);
});

describe('T9: customer cancels a placed order', () => {
    it('cancelled by the customer (customer_cancelled); one void queued; 200 with the order view', async () => {
        const { orderId, customer, piId } = await placedOrder();

        const res = await customerCancel(orderId, customer);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ id: orderId, status: 'cancelled', cancelReason: 'customer_cancelled', paymentStatus: 'authorized' });
        expect(await kitchenRow(orderId)).toMatchObject({
            status: 'cancelled', cancelled_by: 'customer', cancel_reason: 'customer_cancelled', ended_at: expect.any(Date),
        });
        const voids = await outboxRows(orderId, 'payment.void');
        expect(voids).toHaveLength(1);
        expect(voids[0]).toMatchObject({ idempotency_key: `order:${orderId}:void`, payload: { paymentIntentId: piId } });
        expect(await historyWithReason(orderId)).toContainEqual({
            from_status: 'placed', to_status: 'cancelled', actor: `user:${customer.user.id}`, reason: 'cancelled by the customer',
        });
    });

    it('does not put the items back into the cart (only T5, the abandoned checkout, does)', async () => {
        const { orderId, customer } = await placedOrder();

        await customerCancel(orderId, customer);

        expect(await cartLines(customer)).toEqual([]);
    });

    it('a second cancel (double click) answers 200 and changes nothing; still one void', async () => {
        const { orderId, customer } = await placedOrder();
        await customerCancel(orderId, customer);
        const version = (await kitchenRow(orderId)).version;

        const again = await customerCancel(orderId, customer);

        expect(again.status).toBe(200);
        expect(again.body.status).toBe('cancelled');
        expect((await kitchenRow(orderId)).version).toBe(version);
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(1);
    });
});

describe('T9: refusals (from accepted on, only support can cancel)', () => {
    it('409 ORDER_NOT_CANCELLABLE once the restaurant accepted', async () => {
        const { orderId, customer } = await acceptedOrder();

        const res = await customerCancel(orderId, customer);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'ORDER_NOT_CANCELLABLE', details: { status: 'accepted' } });
        expect((await kitchenRow(orderId)).status).toBe('accepted');
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(0);
    });

    it('409 ORDER_NOT_CANCELLABLE once ready_for_pickup', async () => {
        const { orderId, customer, owner } = await acceptedOrder();
        await ready(orderId, owner);

        const res = await customerCancel(orderId, customer);

        expect(res.status).toBe(409);
        expect(res.body.error.details).toEqual({ status: 'ready_for_pickup' });
    });

    it('the restaurant owner cannot use the customer endpoint (403)', async () => {
        const { orderId, owner } = await placedOrder();

        const res = await api().post(`/orders/${orderId}/cancel`).set(owner);

        expect(res.status).toBe(403);
        expect((await kitchenRow(orderId)).status).toBe('placed');
    });
});
