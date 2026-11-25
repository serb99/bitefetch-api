import { mockRoute, getCart } from '../../helpers/customer';
import { outboxRows, pendingOrder, authorize, orderRow } from '../../helpers/payments';
import { fakeStripe } from '../../helpers/fakeStripe';
import { placedOrder, acceptedOrder, accept, ready, kitchenRow, historyWithReason } from '../../helpers/restaurantOrders';
import { createCourier, readyOrder, pendingOfferOf, acceptOffer, pickedUpOrder } from '../../helpers/dispatch';
import { cancelWithBody, passDispatchDeadline } from '../../helpers/unhappy';
import { dispatchDueOrders, markNoCourierOrders } from '../../../src/services/dispatchService';

// Unhappy path "Customer cancels": during checkout, waiting for the restaurant,
// the restaurant accepted a moment earlier, no courier found. Cancel is offered only in those three cases.

beforeEach(() => {
    mockRoute(3001);
});

describe('during checkout', () => {
    it('cancelled (abandoned_checkout), the cart is back, one void queued', async () => {
        const { order, customer, shop } = await pendingOrder();

        const res = await cancelWithBody(order.id, customer);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'cancelled', cancelReason: 'abandoned_checkout' });
        expect((await getCart(customer)).body.items).toEqual([expect.objectContaining({ menuItemId: shop.pizzaId, quantity: 2 })]);
        expect(await outboxRows(order.id, 'payment.void')).toHaveLength(1);
    });

    it('a late authorization after the cancel: the webhook does nothing but the one void (same key)', async () => {
        const { order, customer, piId } = await pendingOrder();
        await cancelWithBody(order.id, customer);

        await authorize(order.id, piId);

        expect((await orderRow(order.id)).status).toBe('cancelled');
        expect(await outboxRows(order.id, 'payment.void')).toHaveLength(1);
        expect(fakeStripe.get(piId).status).toBe('requires_capture'); // released when the outbox runs
    });
});

describe('waiting for the restaurant', () => {
    it('cancelled with the optional reason as a note; not charged; the order view shows it', async () => {
        const { orderId, customer } = await placedOrder();

        const res = await cancelWithBody(orderId, customer, { note: 'ordered the wrong pizza' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'cancelled', cancelReason: 'customer_cancelled', cancelNote: 'ordered the wrong pizza' });
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(1);
        expect((await historyWithReason(orderId)).at(-1)).toMatchObject({ to_status: 'cancelled', reason: 'cancelled by the customer' });
    });

    it('double tap: 200 again with the same order, one void', async () => {
        const { orderId, customer } = await placedOrder();

        const first = await cancelWithBody(orderId, customer);
        const second = await cancelWithBody(orderId, customer);

        expect(second.status).toBe(200);
        expect(second.body.status).toBe(first.body.status);
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(1);
    });

    it('400 for a note longer than 500 characters', async () => {
        const { orderId, customer } = await placedOrder();

        const res = await cancelWithBody(orderId, customer, { note: 'x'.repeat(501) });

        expect(res.status).toBe(400);
        expect((await kitchenRow(orderId)).status).toBe('placed');
    });

    it('cancel vs restaurant accept at the same moment: one wins, the loser gets 409', async () => {
        const { orderId, customer, owner } = await placedOrder();

        const [cancelled, accepted] = await Promise.all([cancelWithBody(orderId, customer), accept(orderId, owner)]);

        expect([cancelled.status, accepted.status].sort()).toEqual([200, 409]);
        const status = (await kitchenRow(orderId)).status;
        expect(status).toBe(cancelled.status === 200 ? 'cancelled' : 'accepted');
    });
});

describe('the restaurant accepted a moment earlier', () => {
    it('409 ORDER_NOT_CANCELLABLE {status: accepted} ("Chat with support")', async () => {
        const { orderId, customer } = await acceptedOrder();

        const res = await cancelWithBody(orderId, customer);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'ORDER_NOT_CANCELLABLE', details: { status: 'accepted', dispatchState: 'not_started' } });
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(0);
    });

    it('409 once a courier is assigned ("A courier just accepted this order")', async () => {
        const courier = await createCourier();
        const order = await readyOrder();
        await dispatchDueOrders();
        await acceptOffer(courier, (await pendingOfferOf(courier.id))!.id);

        const res = await cancelWithBody(order.orderId, order.customer);

        expect(res.body.error).toMatchObject({ code: 'ORDER_NOT_CANCELLABLE', message: 'A courier just accepted this order' });
    });

    it('409 after pickup: only the admin can cancel now', async () => {
        const courier = await createCourier();
        const { orderId, customer } = await pickedUpOrder(courier);

        const res = await cancelWithBody(orderId, customer);

        expect(res.body.error).toMatchObject({ code: 'ORDER_NOT_CANCELLABLE', details: { status: 'picked_up' } });
    });
});

describe('no courier found', () => {
    it('works from accepted (not ready yet) as well', async () => {
        const { orderId, customer, owner } = await acceptedOrder();
        await ready(orderId, owner); // dispatch only starts near the ready time; ready makes it due now
        await dispatchDueOrders();
        await passDispatchDeadline(orderId);
        await markNoCourierOrders();

        const res = await cancelWithBody(orderId, customer);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'cancelled', cancelReason: 'no_courier', dispatchState: 'no_courier' });
    });
});
