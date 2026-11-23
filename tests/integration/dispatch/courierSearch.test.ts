import { BRASOV } from '../../helpers/catalog';
import { mockRoute } from '../../helpers/customer';
import { dispatchDueOrders } from '../../../src/services/dispatchService';
import { expireTimedOutOffers } from '../../../src/services/offerTimeout';
import { distanceMeters } from '../../../src/utils/geo';
import {
    createCourier, moved, dispatchSettings, readyOrder, assignedOrder, offersFor, pendingOfferOf, offersOf,
    declineOffer, passOfferDeadline, makeSearchDue, dispatchRow,
} from '../../helpers/dispatch';

// M7 S2: which courier gets the offer (src/services/courierSearch.ts).
// The restaurant of readyOrder() is at BRASOV, so a courier's distance is measured from there.

beforeEach(() => {
    mockRoute(3001);
});

// The courier who got the first offer for this order.
async function offeredTo(orderId: string): Promise<string | undefined> {
    return (await offersFor(orderId))[0]?.courier_id;
}

describe('dispatch picks the nearest courier', () => {
    it('three couriers at 5 km, 300 m and 1 km: the 300 m one', async () => {
        const far = await createCourier({ at: moved(BRASOV, 5_000) });
        const near = await createCourier({ at: moved(BRASOV, 300) });
        const middle = await createCourier({ at: moved(BRASOV, -1_000) });
        const { orderId } = await readyOrder();

        await dispatchDueOrders();

        expect(await offeredTo(orderId)).toBe(near.id);
        const [offer] = await offersFor(orderId);
        expect(offer.distance_m).toBe(300);
        expect(await offersOf(far.id)).toHaveLength(0);
        expect(await offersOf(middle.id)).toHaveLength(0);
    });

    it('same distance: the one who went online first', async () => {
        // created first (lower id) but online for less time
        const newcomer = await createCourier({ at: moved(BRASOV, 500), wentOnlineAgoS: 30 });
        const veteran = await createCourier({ at: moved(BRASOV, -500), wentOnlineAgoS: 600 });
        const { orderId } = await readyOrder();

        await dispatchDueOrders();

        expect(await offeredTo(orderId)).toBe(veteran.id);
        expect(await offersOf(newcomer.id)).toHaveLength(0);
    });
});

describe('who is never offered (a fallback courier at 2 km gets it instead)', () => {
    async function nearAndFallback(nearOptions: Parameters<typeof createCourier>[0]) {
        const near = await createCourier({ at: moved(BRASOV, 200), ...nearOptions });
        const fallback = await createCourier({ at: moved(BRASOV, 2_000) });
        return { near, fallback };
    }

    it('an offline courier', async () => {
        const { near, fallback } = await nearAndFallback({ online: false });
        const { orderId } = await readyOrder();

        await dispatchDueOrders();

        expect(await offeredTo(orderId)).toBe(fallback.id);
        expect(await offersOf(near.id)).toHaveLength(0);
    });

    it('a courier whose last position is older than courier_fresh_position_s', async () => {
        const { courier_fresh_position_s: freshS } = await dispatchSettings();
        const { near, fallback } = await nearAndFallback({ positionAgeS: freshS + 5 });
        const { orderId } = await readyOrder();

        await dispatchDueOrders();

        expect(await offeredTo(orderId)).toBe(fallback.id);
        expect(await offersOf(near.id)).toHaveLength(0);
    });

    it('a suspended courier, even if still marked online', async () => {
        const { near, fallback } = await nearAndFallback({ status: 'suspended' });
        const { orderId } = await readyOrder();

        await dispatchDueOrders();

        expect(await offeredTo(orderId)).toBe(fallback.id);
        expect(await offersOf(near.id)).toHaveLength(0);
    });

    it('a courier who is already delivering another order', async () => {
        const near = await createCourier({ at: moved(BRASOV, 200) });
        await assignedOrder(near);
        const fallback = await createCourier({ at: moved(BRASOV, 2_000) });
        const { orderId } = await readyOrder();

        await dispatchDueOrders();

        expect(await offeredTo(orderId)).toBe(fallback.id);
    });

    it('a courier who is still deciding on another offer', async () => {
        const near = await createCourier({ at: moved(BRASOV, 200) });
        const fallback = await createCourier({ at: moved(BRASOV, 2_000) });
        const first = await readyOrder();
        const second = await readyOrder();

        await dispatchDueOrders();

        // the older order gets the nearest courier, the second one the next free courier
        expect(await offeredTo(first.orderId)).toBe(near.id);
        expect(await offeredTo(second.orderId)).toBe(fallback.id);
    });

    it('a courier who declined this order in this round is not asked again', async () => {
        const near = await createCourier({ at: moved(BRASOV, 200) });
        const fallback = await createCourier({ at: moved(BRASOV, 2_000) });
        const { orderId } = await readyOrder();
        await dispatchDueOrders();
        const offer = await pendingOfferOf(near.id);

        await declineOffer(near, offer!.id, { reason: 'busy' });
        // the fallback declines too: nobody is left in round 1
        const next = await pendingOfferOf(fallback.id);
        expect(next?.order_id).toBe(orderId);
        await declineOffer(fallback, next!.id);
        await makeSearchDue(orderId);
        await dispatchDueOrders();

        const offers = await offersFor(orderId);
        expect(offers.map((o) => [o.courier_id, o.status])).toEqual([
            [near.id, 'declined'],
            [fallback.id, 'declined'],
        ]);
    });

    it('a courier whose offer for this order expired is not asked again in this round', async () => {
        const near = await createCourier({ at: moved(BRASOV, 200) });
        const { orderId } = await readyOrder();
        await dispatchDueOrders();
        const offer = await pendingOfferOf(near.id);
        await passOfferDeadline(offer!.id);
        expect(await expireTimedOutOffers()).toBe(1);
        const fallback = await createCourier({ at: moved(BRASOV, 2_000) });
        await makeSearchDue(orderId);

        await dispatchDueOrders();

        const offers = await offersFor(orderId);
        expect(offers.map((o) => [o.courier_id, o.status])).toEqual([
            [near.id, 'expired'],
            [fallback.id, 'pending'],
        ]);
    });
});

describe('search radius: 10 km from the restaurant', () => {
    it('9.9 km away: offered', async () => {
        const courier = await createCourier({ at: moved(BRASOV, 9_900) });
        const { orderId } = await readyOrder();

        await dispatchDueOrders();

        expect(await offeredTo(orderId)).toBe(courier.id);
    });

    it('10.1 km away: not offered, the order waits (backoff) with no offer', async () => {
        await createCourier({ at: moved(BRASOV, 10_100) });
        const { orderId } = await readyOrder();

        await dispatchDueOrders();

        expect(await offersFor(orderId)).toHaveLength(0);
        const row = await dispatchRow(orderId);
        expect(row.dispatch_state).toBe('searching');
        expect(row.next_search_at!.getTime()).toBeGreaterThan(row.db_now.getTime());
    });

    it.each([
        ['east (longitude is the narrow side of the box)', 0, 9_990],
        ['north', 9_990, 0],
        ['north-east, on the diagonal', 7_060, 7_060],
    ])('the bounding box never cuts the circle: 9.99 km %s is offered', async (_name, northM, eastM) => {
        const at = moved(BRASOV, northM, eastM);
        expect(distanceMeters(BRASOV, at)).toBeLessThan(10_000);
        const courier = await createCourier({ at });
        const { orderId } = await readyOrder();

        await dispatchDueOrders();

        expect(await offeredTo(orderId)).toBe(courier.id);
    });
});
