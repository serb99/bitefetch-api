import { api } from '../../helpers/http';
import { mockRoute, checkout, readyCart, createCustomer, setItem, getCart } from '../../helpers/customer';
import { fakeStripe } from '../../helpers/fakeStripe';
import { TOTAL, pendingOrder, authorize, orderRow, outboxRows, cartLines, statusHistory } from '../../helpers/payments';

beforeEach(() => {
    mockRoute(3001);
});

function cancel(orderId: string, headers?: { Authorization: string }) {
    const req = api().post(`/orders/${orderId}/cancel`);
    return headers ? req.set(headers) : req;
}

describe('T5: POST /orders/:id/cancel while pending_payment', () => {
    it('cancels: customer, abandoned_checkout, ended_at; queues one void; answers with the order', async () => {
        const { order, customer, piId } = await pendingOrder();

        const res = await cancel(order.id, customer.headers);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ id: order.id, status: 'cancelled', cancelReason: 'abandoned_checkout', paymentStatus: 'pending' });
        expect(await orderRow(order.id)).toMatchObject({
            status: 'cancelled',
            cancelled_by: 'customer',
            cancel_reason: 'abandoned_checkout',
            ended_at: expect.any(Date),
        });
        const voids = await outboxRows(order.id, 'payment.void');
        expect(voids).toHaveLength(1);
        expect(voids[0]).toMatchObject({ idempotency_key: `order:${order.id}:void`, payload: { paymentIntentId: piId } });
        expect(await statusHistory(order.id)).toContainEqual(
            expect.objectContaining({ from_status: 'pending_payment', to_status: 'cancelled', actor: `user:${customer.user.id}` })
        );
        // Stripe is not called inside the request: the void waits for the outbox runner.
        expect(fakeStripe.calls('cancel')).toHaveLength(0);
    });

    it('puts the items back into the (empty) cart, with the restaurant', async () => {
        const { order, customer, shop } = await pendingOrder();

        await cancel(order.id, customer.headers);

        const cart = await getCart(customer);
        expect(cart.body.restaurant).toMatchObject({ id: shop.restaurantId });
        expect(await cartLines(customer)).toEqual([{ menuItemId: shop.pizzaId, quantity: 2 }]);
    });

    it('leaves a cart the customer already started again untouched', async () => {
        const { order, customer, shop } = await pendingOrder();
        await setItem(customer, shop.colaId, shop.restaurantId, 1);

        await cancel(order.id, customer.headers);

        expect(await cartLines(customer)).toEqual([{ menuItemId: shop.colaId, quantity: 1 }]);
    });

    it('a second cancel (double click) answers 200 with the same order and changes nothing', async () => {
        const { order, customer } = await pendingOrder();
        await cancel(order.id, customer.headers);
        const version = (await orderRow(order.id)).version;

        const again = await cancel(order.id, customer.headers);

        expect(again.status).toBe(200);
        expect(again.body.status).toBe('cancelled');
        expect((await orderRow(order.id)).version).toBe(version);
        expect(await outboxRows(order.id, 'payment.void')).toHaveLength(1);
        expect(await cartLines(customer)).toHaveLength(1);
    });

    it('no PaymentIntent (Stripe was down at checkout): cancelled, nothing to void', async () => {
        const { customer } = await readyCart();
        fakeStripe.failNext('create');
        const created = await checkout(customer, TOTAL);

        const res = await cancel(created.body.id, customer.headers);

        expect(res.status).toBe(200);
        expect(await outboxRows(created.body.id)).toHaveLength(0);
    });
});

describe('T5: refusals', () => {
    it('409 ORDER_NOT_CANCELLABLE once the order is placed (details.status)', async () => {
        const { order, customer, piId } = await pendingOrder();
        await authorize(order.id, piId);

        const res = await cancel(order.id, customer.headers);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'ORDER_NOT_CANCELLABLE', details: { status: 'placed' } });
        expect((await orderRow(order.id)).status).toBe('placed');
    });

    it('404 for another customer\'s order, 401 without a login, 400 for a bad id', async () => {
        const { order } = await pendingOrder();
        const other = await createCustomer();

        expect((await cancel(order.id, other.headers)).status).toBe(404);
        expect((await cancel(order.id)).status).toBe(401);
        expect((await cancel('abc', other.headers)).status).toBe(400);
        expect((await orderRow(order.id)).status).toBe('pending_payment');
    });
});
