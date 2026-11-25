import { BRASOV } from '../../helpers/catalog';
import { mockRoute } from '../../helpers/customer';
import {
    createCourier, moved, readyOrder, dispatchRow, offersFor, pendingOfferOf, profileRow, acceptOffer, passOfferDeadline,
    makeSearchDue, currentOffer,
} from '../../helpers/dispatch';
import { setMissedOffers } from '../../helpers/unhappy';
import { dispatchDueOrders } from '../../../src/services/dispatchService';
import { expireTimedOutOffers, MISSED_OFFERS_LIMIT } from '../../../src/services/offerTimeout';

// Unhappy path "Offer times out": expiry, the missed-offer count (offline after 2 in a row), the next courier.

beforeEach(() => {
    mockRoute(3001);
});

// A ready order offered to `courier`.
async function offeredTo(courier: Awaited<ReturnType<typeof createCourier>>) {
    const order = await readyOrder();
    await dispatchDueOrders();
    const offer = await pendingOfferOf(courier.id);
    if (!offer) throw new Error('no offer');
    return { offerId: offer.id, ...order };
}

it('the limit is 2 missed offers in a row', () => {
    expect(MISSED_OFFERS_LIMIT).toBe(2);
});

describe('the deadline passes', () => {
    it('first miss: expired, count 1, the courier stays online; the next pass offers the next courier', async () => {
        const courier1 = await createCourier({ at: moved(BRASOV, 200) });
        const courier2 = await createCourier({ at: moved(BRASOV, 600) });
        const { offerId, orderId } = await offeredTo(courier1);
        await passOfferDeadline(offerId);

        expect(await expireTimedOutOffers()).toBe(1);

        expect(await profileRow(courier1.id)).toMatchObject({ availability: 'online', consecutive_missed_offers: 1 });
        await makeSearchDue(orderId);
        await dispatchDueOrders();
        const offers = await offersFor(orderId);
        expect(offers.map((o) => [o.courier_id, o.status])).toEqual([
            [courier1.id, 'expired'],
            [courier2.id, 'pending'],
        ]);
        expect((await dispatchRow(orderId)).dispatch_state).toBe('searching');
    });

    it('second miss in a row: the courier goes offline (missed_offers) and gets no more offers', async () => {
        const courier = await createCourier();
        await setMissedOffers(courier.id, 1);
        const { offerId, orderId } = await offeredTo(courier);
        await passOfferDeadline(offerId);

        await expireTimedOutOffers();

        expect(await profileRow(courier.id)).toMatchObject({
            availability: 'offline', offline_reason: 'missed_offers', consecutive_missed_offers: 2,
        });
        await readyOrder();
        await makeSearchDue(orderId);
        await dispatchDueOrders();
        expect(await pendingOfferOf(courier.id)).toBeUndefined();
        expect((await currentOffer(courier)).body).toEqual({ offer: null });
    });

    it('an accept in between resets the count: miss, accept, miss = still online', async () => {
        const courier = await createCourier();
        await setMissedOffers(courier.id, 1);
        const { offerId } = await offeredTo(courier);

        await acceptOffer(courier, offerId);

        expect((await profileRow(courier.id)).consecutive_missed_offers).toBe(0);
    });

    it('two sweeps at once: the offer is expired once and counted once', async () => {
        const courier = await createCourier();
        const { offerId } = await offeredTo(courier);
        await passOfferDeadline(offerId);

        const [a, b] = await Promise.all([expireTimedOutOffers(), expireTimedOutOffers()]);

        expect(a + b).toBe(1);
        expect((await profileRow(courier.id)).consecutive_missed_offers).toBe(1);
    });

    it('an offer still inside its 30 s is not touched', async () => {
        const courier = await createCourier();
        await offeredTo(courier);

        expect(await expireTimedOutOffers()).toBe(0);

        expect((await profileRow(courier.id)).consecutive_missed_offers).toBe(0);
    });
});

describe('late accept from courier 1 (stale card or slow network)', () => {
    it('after the sweep: 409 OFFER_CLOSED {offerStatus: expired}, the order stays unassigned', async () => {
        const courier = await createCourier();
        const { offerId, orderId } = await offeredTo(courier);
        await passOfferDeadline(offerId);
        await expireTimedOutOffers();

        const res = await acceptOffer(courier, offerId);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'OFFER_CLOSED', details: { offerStatus: 'expired' } });
        expect((await dispatchRow(orderId)).courier_id).toBeNull();
    });

    it('before the sweep (past expires_at): also 409 expired; the count is not reset by a late tap', async () => {
        const courier = await createCourier();
        await setMissedOffers(courier.id, 1);
        const { offerId } = await offeredTo(courier);
        await passOfferDeadline(offerId);

        const res = await acceptOffer(courier, offerId);

        expect(res.body.error).toMatchObject({ code: 'OFFER_CLOSED', details: { offerStatus: 'expired' } });
        expect((await profileRow(courier.id)).consecutive_missed_offers).toBe(1);
    });
});

describe('after an outage', () => {
    it('the first sweep expires every overdue offer, and a courier who let this order expire is not asked again', async () => {
        const courier1 = await createCourier({ at: moved(BRASOV, 200) });
        const first = await offeredTo(courier1);
        const courier2 = await createCourier({ at: moved(BRASOV, 200, 50) });
        const second = await readyOrder();
        await dispatchDueOrders();
        await passOfferDeadline(first.offerId);
        await passOfferDeadline((await pendingOfferOf(courier2.id))!.id);

        expect(await expireTimedOutOffers()).toBe(2);

        // Both couriers are free again; each order goes to the courier who did NOT ignore it
        await makeSearchDue(first.orderId);
        await makeSearchDue(second.orderId);
        await dispatchDueOrders();
        expect((await pendingOfferOf(courier1.id))?.order_id).toBe(second.orderId);
        expect((await pendingOfferOf(courier2.id))?.order_id).toBe(first.orderId);
    });
});
