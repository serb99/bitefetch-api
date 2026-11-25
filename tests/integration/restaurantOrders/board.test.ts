import { pool } from '../../helpers/db';
import { mockRoute, createShop, createCustomer } from '../../helpers/customer';
import {
    placedOrderAt, pendingOrderAt, accept, reject, ready, board, passAcceptDeadline, ownerWithoutRestaurant,
    type Shop,
} from '../../helpers/restaurantOrders';
import { createAdmin, decideCancelRequest, requestCancel } from '../../helpers/unhappy';

// GET /owner/orders: the kitchen board (placed, accepted, ready_for_pickup), most urgent first.

beforeEach(() => {
    mockRoute(3001);
});

async function setOrderTime(orderId: string, column: 'accept_deadline' | 'ready_at', secondsFromNow: number) {
    await pool.query(`UPDATE orders SET ${column} = now() + make_interval(secs => $2) WHERE id = $1`, [orderId, secondsFromNow]);
}

async function acceptedAt(shop: Shop, prepMinutes: number): Promise<string> {
    const { orderId } = await placedOrderAt(shop);
    await accept(orderId, shop.headers, { prepMinutes });
    return orderId;
}

describe('GET /owner/orders', () => {
    it('one order: the kitchen fields, items as menuItemId + name + quantity, no customer data', async () => {
        const shop = await createShop();
        const { orderId } = await placedOrderAt(shop);

        const res = await board(shop.headers);

        expect(res.status).toBe(200);
        expect(res.body).toEqual([{
            id: orderId,
            orderCode: expect.stringMatching(/^BF-[A-Z0-9]{5}$/),
            status: 'placed',
            subtotalMinor: 1600,
            currency: 'EUR',
            placedAt: expect.any(String),
            acceptDeadline: expect.any(String),
            prepMinutes: null,
            estimatedReadyAt: null,
            readyAt: null,
            cancelRequestPending: false,
            items: [{ menuItemId: shop.pizzaId, name: 'Pizza', quantity: 2 }],
        }]);
    });

    it('menuItemId is a string (bigint cast inside json_build_object), null once the dish is gone', async () => {
        const shop = await createShop();
        const { orderId } = await placedOrderAt(shop);

        const before = await board(shop.headers);
        expect(typeof before.body[0].items[0].menuItemId).toBe('string');

        // What ON DELETE SET NULL leaves behind when the owner deletes the dish after the order
        await pool.query('UPDATE order_items SET menu_item_id = NULL WHERE order_id = $1', [orderId]);

        const after = await board(shop.headers);
        expect(after.body[0].items).toEqual([{ menuItemId: null, name: 'Pizza', quantity: 2 }]);
    });

    it('cancelRequestPending: false, true after the owner asks, false again once the admin decides', async () => {
        const shop = await createShop();
        const orderId = await acceptedAt(shop, 20);
        await ready(orderId, shop.headers);
        const pending = async () => (await board(shop.headers)).body[0].cancelRequestPending;

        expect(await pending()).toBe(false);

        const request = (await requestCancel(orderId, shop.headers)).body;
        expect(await pending()).toBe(true);

        const admin = await createAdmin();
        await decideCancelRequest(admin, request.id, 'reject', { version: request.version });
        expect(await pending()).toBe(false);   // closed request, the order is still on the board
    });

    it('groups placed → accepted → ready, each group sorted by its own deadline', async () => {
        const shop = await createShop();
        const placedLater = (await placedOrderAt(shop)).orderId;
        const placedSooner = (await placedOrderAt(shop)).orderId;
        await setOrderTime(placedSooner, 'accept_deadline', 60);
        const slowKitchen = await acceptedAt(shop, 40);
        const quickKitchen = await acceptedAt(shop, 15);
        const readyRecent = await acceptedAt(shop, 20);
        const readyLongAgo = await acceptedAt(shop, 20);
        await ready(readyRecent, shop.headers);
        await ready(readyLongAgo, shop.headers);
        await setOrderTime(readyLongAgo, 'ready_at', -600);

        const res = await board(shop.headers);

        expect(res.body.map((o: { id: string }) => o.id)).toEqual([
            placedSooner, placedLater, quickKitchen, slowKitchen, readyLongAgo, readyRecent,
        ]);
    });

    it('accepted orders sort by estimated ready time, not by their old accept deadline', async () => {
        const shop = await createShop();
        const acceptedFirstSlow = await acceptedAt(shop, 60);  // older accept_deadline, ready last
        const acceptedLaterQuick = await acceptedAt(shop, 10); // newer accept_deadline, ready first

        const res = await board(shop.headers);

        expect(res.body.map((o: { id: string }) => o.id)).toEqual([acceptedLaterQuick, acceptedFirstSlow]);
    });

    it('leaves out unpaid, past-deadline, ended and other restaurants\' orders', async () => {
        const shop = await createShop();
        const visible = (await placedOrderAt(shop)).orderId;
        await pendingOrderAt(shop);                                   // pending_payment: not paid yet
        const timedOut = (await placedOrderAt(shop)).orderId;         // placed, deadline passed, sweep not run
        await passAcceptDeadline(timedOut);
        const rejected = (await placedOrderAt(shop)).orderId;         // ended
        await reject(rejected, shop.headers);
        const otherShop = await createShop();
        await placedOrderAt(otherShop);                               // someone else's

        const res = await board(shop.headers);

        expect(res.body.map((o: { id: string }) => o.id)).toEqual([visible]);
    });

    it('an empty kitchen is an empty list', async () => {
        const shop = await createShop();

        const res = await board(shop.headers);

        expect(res.status).toBe(200);
        expect(res.body).toEqual([]);
    });

    it('403 NO_RESTAURANT for an owner without a restaurant, 403 for a customer, 401 without login', async () => {
        const noRestaurant = await board(await ownerWithoutRestaurant());
        expect(noRestaurant.status).toBe(403);
        expect(noRestaurant.body.error.code).toBe('NO_RESTAURANT');
        expect((await board((await createCustomer()).headers)).status).toBe(403);
        expect((await board()).status).toBe(401);
    });
});
