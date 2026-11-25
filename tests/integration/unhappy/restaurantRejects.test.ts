import { pool } from '../../helpers/db';
import { mockRoute, getCart, setItem, createShop } from '../../helpers/customer';
import { outboxRows, statusHistory } from '../../helpers/payments';
import {
    placedOrder, placedOrderAt, reject, accept, passAcceptDeadline, kitchenRow, restaurantRow, setMissedOrders,
} from '../../helpers/restaurantOrders';
import { itemAvailability } from '../../helpers/unhappy';
import { rejectTimedOutOrders } from '../../../src/services/acceptTimeout';

// Unhappy path "Restaurant rejects": the owner rejects, or nobody answers in time.
// The ticked items become unavailable and the customer finds the order back in the cart.

beforeEach(() => {
    mockRoute(3001);
});

type CartItem = { menuItemId: string; quantity: number; available: boolean };

async function cartItems(customer: Parameters<typeof getCart>[0]): Promise<CartItem[]> {
    const res = await getCart(customer);
    return res.body.items.map((i: CartItem) => ({ menuItemId: i.menuItemId, quantity: i.quantity, available: i.available }));
}

describe('the owner rejects', () => {
    it('out_of_stock with ticked items: rejected, items unavailable at this restaurant, cart back with them flagged, one void', async () => {
        const { orderId, customer, owner, shop, piId } = await placedOrder();

        const res = await reject(orderId, owner, { reasonCode: 'out_of_stock', unavailableItemIds: [shop.pizzaId] });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'rejected', cancelledBy: 'restaurant', cancelReason: 'out_of_stock' });
        expect(await itemAvailability(shop.restaurantId, shop.pizzaId)).toBe(false);
        expect(await cartItems(customer)).toEqual([{ menuItemId: shop.pizzaId, quantity: 2, available: false }]);
        const voids = await outboxRows(orderId, 'payment.void');
        expect(voids).toHaveLength(1);
        expect(voids[0].payload).toEqual({ paymentIntentId: piId });
        expect((await statusHistory(orderId)).filter((h) => h.to_status === 'rejected')).toHaveLength(1);
    });

    it('only items of THIS order can be ticked: another menu item id is ignored', async () => {
        const { orderId, owner, shop } = await placedOrder();

        const res = await reject(orderId, owner, { reasonCode: 'out_of_stock', unavailableItemIds: [shop.colaId] });

        expect(res.status).toBe(200);
        expect(await itemAvailability(shop.restaurantId, shop.colaId)).toBeNull();
        expect(await itemAvailability(shop.restaurantId, shop.pizzaId)).toBeNull();
    });

    it('without ticks: the cart comes back with available items', async () => {
        const { orderId, customer, owner, shop } = await placedOrder();

        await reject(orderId, owner, { reasonCode: 'too_busy' });

        expect(await cartItems(customer)).toEqual([{ menuItemId: shop.pizzaId, quantity: 2, available: true }]);
    });

    it('a cart the customer already refilled is kept as it is', async () => {
        const { orderId, customer, owner, shop } = await placedOrder();
        await setItem(customer, shop.colaId, shop.restaurantId, 1);

        await reject(orderId, owner, { reasonCode: 'too_busy' });

        expect(await cartItems(customer)).toEqual([{ menuItemId: shop.colaId, quantity: 1, available: true }]);
    });

    it('400 for a bad item id list', async () => {
        const { orderId, owner } = await placedOrder();

        const res = await reject(orderId, owner, { reasonCode: 'out_of_stock', unavailableItemIds: ['abc'] });

        expect(res.status).toBe(400);
        expect((await kitchenRow(orderId)).status).toBe('placed');
    });

    it('double tap: 200 again, one history row, one void, ticks applied once', async () => {
        const { orderId, owner, shop } = await placedOrder();
        const body = { reasonCode: 'out_of_stock', unavailableItemIds: [shop.pizzaId] };

        const first = await reject(orderId, owner, body);
        const second = await reject(orderId, owner, body);

        expect(second.status).toBe(200);
        expect(second.body).toEqual(first.body);
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(1);
        expect((await statusHistory(orderId)).filter((h) => h.to_status === 'rejected')).toHaveLength(1);
    });
});

describe('nobody answers before accept_deadline', () => {
    it('the sweep rejects it (restaurant_timeout), voids it and gives the cart back', async () => {
        const { orderId, customer, shop } = await placedOrder();
        await passAcceptDeadline(orderId);

        expect(await rejectTimedOutOrders()).toBe(1);

        expect(await kitchenRow(orderId)).toMatchObject({ status: 'rejected', cancelled_by: 'system', cancel_reason: 'restaurant_timeout' });
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(1);
        expect(await cartItems(customer)).toEqual([{ menuItemId: shop.pizzaId, quantity: 2, available: true }]);
    });

    it('a late Accept after the sweep: 409 with the status, nothing changes', async () => {
        const { orderId, owner } = await placedOrder();
        await passAcceptDeadline(orderId);
        await rejectTimedOutOrders();

        const res = await accept(orderId, owner);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'ORDER_STATUS_CHANGED', details: { status: 'rejected' } });
    });

    it('the 2nd timeout in a row pauses the restaurant and opens one restaurant_unresponsive incident', async () => {
        const shop = await createShop();
        await setMissedOrders(shop.restaurantId, 1);
        const { orderId } = await placedOrderAt(shop);
        await passAcceptDeadline(orderId);

        await rejectTimedOutOrders();

        const restaurant = await restaurantRow(shop.restaurantId);
        expect(restaurant.consecutive_timeouts).toBe(2);
        expect(restaurant.paused_until).not.toBeNull();
        const { rows } = await pool.query(
            `SELECT type FROM order_incidents WHERE restaurant_id = $1 AND resolved_at IS NULL`,
            [shop.restaurantId]
        );
        expect(rows).toEqual([{ type: 'restaurant_unresponsive' }]);
    });
});
