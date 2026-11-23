import { pool } from '../../helpers/db';
import { BRASOV } from '../../helpers/catalog';
import { mockRoute } from '../../helpers/customer';
import { acceptedOrder, ownerCancel } from '../../helpers/restaurantOrders';
import { dispatchDueOrders } from '../../../src/services/dispatchService';
import { expireTimedOutOffers } from '../../../src/services/offerTimeout';
import {
    createCourier, moved, dispatchSettings, readyOrder, acceptedDueOrder, pickedUpOrder, dispatchRow, offersFor,
    offersOf, pendingOfferOf, setOnline, setPosition, deliver, declineOffer, passOfferDeadline, makeSearchDue,
} from '../../helpers/dispatch';

// M7 S1 (start the search), S2 (offer or back off), S4 (offer expiry) and the kicks after a commit.
// No timer runs in tests: dispatchDueOrders() and expireTimedOutOffers() are what the 2 s timer calls.

beforeEach(() => {
    mockRoute(3001);
});

const seconds = (a: Date, b: Date) => (a.getTime() - b.getTime()) / 1000;

describe('S1: the search starts when dispatch_after is reached', () => {
    it('not before: an accepted order cooking for 30 min is left alone', async () => {
        await createCourier();
        const { orderId } = await acceptedOrder(30);
        const before = await dispatchRow(orderId);
        expect(before.dispatch_after!.getTime()).toBeGreaterThan(before.db_now.getTime());

        expect(await dispatchDueOrders()).toBe(0);

        const row = await dispatchRow(orderId);
        expect(row).toMatchObject({ dispatch_state: 'not_started', version: before.version });
        expect(await offersFor(orderId)).toHaveLength(0);
    });

    it('once reached: searching, round 1, start time, deadline and version + 1', async () => {
        const { dispatch_deadline_s: deadlineS } = await dispatchSettings();
        const { orderId } = await acceptedOrder(30);
        await pool.query(`UPDATE orders SET dispatch_after = now() - interval '1 second' WHERE id = $1`, [orderId]);
        const before = await dispatchRow(orderId);

        expect(await dispatchDueOrders()).toBe(1);

        const row = await dispatchRow(orderId);
        expect(row).toMatchObject({ status: 'accepted', dispatch_state: 'searching', dispatch_round: 1, version: before.version + 1 });
        expect(Math.abs(seconds(row.db_now, row.dispatch_started_at!))).toBeLessThan(5);
        expect(seconds(row.dispatch_deadline!, row.dispatch_started_at!)).toBe(deadlineS);
    });

    it('marking the order ready starts the search at once (dispatch_after moves to now)', async () => {
        const courier = await createCourier();
        const { orderId } = await readyOrder();

        await dispatchDueOrders();

        expect((await pendingOfferOf(courier.id))?.order_id).toBe(orderId);
    });
});

describe('S2: offer, or back off', () => {
    it('the offer: pending, round 1, distance, expires after offer_timeout_s; the order sleeps until then', async () => {
        const { offer_timeout_s: timeoutS } = await dispatchSettings();
        const courier = await createCourier({ at: moved(BRASOV, 300) });
        const { orderId } = await readyOrder();

        await dispatchDueOrders();

        const [offer] = await offersFor(orderId);
        expect(offer).toMatchObject({ courier_id: courier.id, status: 'pending', round: 1, distance_m: 300, responded_at: null });
        expect(seconds(offer.expires_at, offer.offered_at)).toBe(timeoutS);
        expect((await dispatchRow(orderId)).next_search_at).toEqual(offer.expires_at);
    });

    it('one pending offer per order: another pass, even with the order due, makes no second offer', async () => {
        await createCourier({ at: moved(BRASOV, 300) });
        await createCourier({ at: moved(BRASOV, 600) });
        const { orderId } = await readyOrder();
        await dispatchDueOrders();
        await makeSearchDue(orderId);

        await dispatchDueOrders();

        expect(await offersFor(orderId)).toHaveLength(1);
    });

    it.each([
        ['just started: 2 s', 0, 2],
        ['searching for 20 s: 5 s', 20, 5],
        ['searching for 45 s: 10 s', 45, 10],
        ['searching for 2 min: 30 s', 120, 30],
    ])('no courier, %s until the next look', async (_name, ageS, waitS) => {
        const { orderId } = await readyOrder();
        await dispatchDueOrders();
        if (ageS > 0) {
            await pool.query(
                `UPDATE orders SET dispatch_started_at = now() - make_interval(secs => $2), next_search_at = now() - interval '1 second'
                  WHERE id = $1`,
                [orderId, ageS]
            );
            await dispatchDueOrders();
        }

        const row = await dispatchRow(orderId);
        const wait = seconds(row.next_search_at!, row.db_now);
        expect(wait).toBeGreaterThan(waitS - 1.5);
        expect(wait).toBeLessThanOrEqual(waitS);
        expect(await offersFor(orderId)).toHaveLength(0);
    });

    it('an order the restaurant cancelled while searching is never offered', async () => {
        const { orderId, owner } = await acceptedDueOrder();
        await dispatchDueOrders();
        expect((await ownerCancel(orderId, owner)).status).toBe(200);
        await createCourier();
        await makeSearchDue(orderId);

        await dispatchDueOrders();

        expect(await offersFor(orderId)).toHaveLength(0);
    });
});

describe('kicks after a commit (no timer needed)', () => {
    it('a courier going online near a waiting order gets the offer right away', async () => {
        const { orderId } = await readyOrder();
        await dispatchDueOrders(); // nobody yet: the order backs off
        const courier = await createCourier({ online: false });

        const res = await setOnline(courier, true);

        expect(res.status).toBe(200);
        expect((await pendingOfferOf(courier.id))?.order_id).toBe(orderId);
    });

    it('a courier going online far away (over 10 km) does not wake the order', async () => {
        const { orderId } = await readyOrder();
        await dispatchDueOrders();
        const courier = await createCourier({ online: false, at: moved(BRASOV, 15_000) });

        await setOnline(courier, true);

        expect(await offersFor(orderId)).toHaveLength(0);
    });

    it('after T13 the freed courier gets the next waiting order nearby', async () => {
        const courier = await createCourier();
        const first = await pickedUpOrder(courier);
        const second = await readyOrder();
        await dispatchDueOrders(); // the courier is busy: the second order backs off
        expect(await offersFor(second.orderId)).toHaveLength(0);
        await setPosition(courier.id, first.door);

        expect((await deliver(courier, first.orderId)).status).toBe(200);

        expect((await pendingOfferOf(courier.id))?.order_id).toBe(second.orderId);
    });

    it('after a decline the next courier is asked right away', async () => {
        const near = await createCourier({ at: moved(BRASOV, 200) });
        const next = await createCourier({ at: moved(BRASOV, 800) });
        const { orderId } = await readyOrder();
        await dispatchDueOrders();

        await declineOffer(near, (await pendingOfferOf(near.id))!.id);

        expect((await pendingOfferOf(next.id))?.order_id).toBe(orderId);
    });
});

describe('S4: offers nobody answers expire', () => {
    it('expireTimedOutOffers expires only overdue offers', async () => {
        const courier = await createCourier();
        await readyOrder();
        await dispatchDueOrders();

        expect(await expireTimedOutOffers()).toBe(0);
        const offer = (await pendingOfferOf(courier.id))!;
        await passOfferDeadline(offer.id);
        expect(await expireTimedOutOffers()).toBe(1);

        const [row] = await offersOf(courier.id);
        expect(row.status).toBe('expired');
        expect(row.responded_at).not.toBeNull();
        expect(await expireTimedOutOffers()).toBe(0);
    });

    it('the next pass after the expiry offers the order to another courier', async () => {
        const first = await createCourier({ at: moved(BRASOV, 200) });
        const second = await createCourier({ at: moved(BRASOV, 900) });
        const { orderId } = await readyOrder();
        await dispatchDueOrders();
        await passOfferDeadline((await pendingOfferOf(first.id))!.id);
        await expireTimedOutOffers();
        await makeSearchDue(orderId); // next_search_at was set to the original expiry

        await dispatchDueOrders();

        expect((await pendingOfferOf(second.id))?.order_id).toBe(orderId);
        expect(await offersOf(first.id)).toHaveLength(1);
    });
});
