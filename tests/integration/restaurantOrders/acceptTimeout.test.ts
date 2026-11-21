import { mockRoute, createShop } from '../../helpers/customer';
import { outboxRows } from '../../helpers/payments';
import { fakeStripe } from '../../helpers/fakeStripe';
import { rejectTimedOutOrders } from '../../../src/services/acceptTimeout';
import {
    placedOrder, placedOrderAt, acceptedOrder, accept, kitchenRow, restaurantRow, setMissedOrders,
    passAcceptDeadline, incidents, historyWithReason,
} from '../../helpers/restaurantOrders';

// T8: the 5 s job (jobs/paymentJobs.ts) calls rejectTimedOutOrders(). No timer runs in tests,
// so the sweep is called directly, like the expiry sweep in payments/expiry.test.ts.

const DAY = 24 * 60 * 60_000;

beforeEach(() => {
    mockRoute(3001);
});

describe('T8: placed order not answered in time', () => {
    it('rejects it as the system (restaurant_timeout), queues the void, counts one missed order', async () => {
        const { orderId, shop, piId } = await placedOrder();
        await passAcceptDeadline(orderId);

        expect(await rejectTimedOutOrders()).toBe(1);

        expect(await kitchenRow(orderId)).toMatchObject({
            status: 'rejected', cancelled_by: 'system', cancel_reason: 'restaurant_timeout', ended_at: expect.any(Date),
        });
        const voids = await outboxRows(orderId, 'payment.void');
        expect(voids).toHaveLength(1);
        expect(voids[0].payload).toEqual({ paymentIntentId: piId });
        expect(fakeStripe.calls('cancel')).toHaveLength(0);
        expect(await historyWithReason(orderId)).toContainEqual({
            from_status: 'placed', to_status: 'rejected', actor: 'system:accept-timeout', reason: 'restaurant did not answer in time',
        });
        expect(await restaurantRow(shop.restaurantId)).toEqual({ consecutive_timeouts: 1, paused_until: null });
        expect(await incidents(shop.restaurantId)).toEqual([]);
    });

    it('leaves orders whose deadline is still ahead, and orders that are no longer placed', async () => {
        const waiting = await placedOrder();
        const accepted = await acceptedOrder();
        await passAcceptDeadline(accepted.orderId); // accept_deadline stays set after T6

        expect(await rejectTimedOutOrders()).toBe(0);

        expect((await kitchenRow(waiting.orderId)).status).toBe('placed');
        expect((await kitchenRow(accepted.orderId)).status).toBe('accepted');
    });

    it('the 2nd missed order in a row pauses the restaurant for 30 days and opens one restaurant_unresponsive incident', async () => {
        const shop = await createShop();
        await setMissedOrders(shop.restaurantId, 1);
        const { orderId } = await placedOrderAt(shop);
        await passAcceptDeadline(orderId);
        const before = Date.now();

        await rejectTimedOutOrders();

        const restaurant = await restaurantRow(shop.restaurantId);
        expect(restaurant.consecutive_timeouts).toBe(2);
        const pausedFor = restaurant.paused_until!.getTime() - before;
        expect(pausedFor).toBeGreaterThan(30 * DAY - 60_000);
        expect(pausedFor).toBeLessThan(30 * DAY + 60_000);
        expect(await incidents(shop.restaurantId)).toEqual([{
            order_id: null, restaurant_id: shop.restaurantId, type: 'restaurant_unresponsive', opened_by: 'system',
            details: `2 orders in a row not answered (last: order ${orderId})`, resolved_at: null, resolution_note: null,
        }]);
    });

    it('two timed-out orders of the same restaurant in one pass: both rejected, still one open incident', async () => {
        const shop = await createShop();
        await setMissedOrders(shop.restaurantId, 1);
        const first = await placedOrderAt(shop);
        const second = await placedOrderAt(shop);
        await passAcceptDeadline(first.orderId);
        await passAcceptDeadline(second.orderId);

        expect(await rejectTimedOutOrders()).toBe(2);

        expect((await restaurantRow(shop.restaurantId)).consecutive_timeouts).toBe(3);
        expect(await incidents(shop.restaurantId)).toHaveLength(1);
    });

    it('an answer in between resets the counter: missed, answered, missed → 1, not 2', async () => {
        const shop = await createShop();
        const missed1 = await placedOrderAt(shop);
        await passAcceptDeadline(missed1.orderId);
        await rejectTimedOutOrders();
        const answered = await placedOrderAt(shop);
        await accept(answered.orderId, shop.headers);
        const missed2 = await placedOrderAt(shop);
        await passAcceptDeadline(missed2.orderId);

        await rejectTimedOutOrders();

        expect(await restaurantRow(shop.restaurantId)).toEqual({ consecutive_timeouts: 1, paused_until: null });
    });

    it('a second pass finds nothing more to do', async () => {
        const { orderId } = await placedOrder();
        await passAcceptDeadline(orderId);
        await rejectTimedOutOrders();

        expect(await rejectTimedOutOrders()).toBe(0);
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(1);
    });
});
