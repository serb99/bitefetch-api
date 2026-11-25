import { BRASOV } from '../../helpers/catalog';
import { mockRoute } from '../../helpers/customer';
import {
    createCourier, moved, readyOrder, dispatchRow, offersFor, pendingOfferOf, profileRow, acceptOffer, declineOffer,
    passOfferDeadline,
} from '../../helpers/dispatch';
import { ownerCancel, acceptedOrder } from '../../helpers/restaurantOrders';
import { pool } from '../../helpers/db';
import { setMissedOffers, cancelWithBody } from '../../helpers/unhappy';
import { dispatchDueOrders } from '../../../src/services/dispatchService';
import { expireTimedOutOffers } from '../../../src/services/offerTimeout';
import { getCustomerOrder } from '../../../src/services/orderService';

// Unhappy path "Courier declines": the decline, then the next nearest courier is offered.

beforeEach(() => {
    mockRoute(3001);
});

// Courier 1 nearest (200 m), courier 2 next (600 m); courier 1 holds the offer for a ready order.
async function offeredToNearest() {
    const courier1 = await createCourier({ at: moved(BRASOV, 200) });
    const courier2 = await createCourier({ at: moved(BRASOV, 600) });
    const order = await readyOrder();
    await dispatchDueOrders();
    const offer = await pendingOfferOf(courier1.id);
    if (!offer) throw new Error('courier 1 got no offer');
    return { courier1, courier2, offerId: offer.id, ...order };
}

describe('courier 1 declines', () => {
    it('declined with the reason, courier 1 stays online and idle, courier 2 is offered at once in the same round', async () => {
        const { courier1, courier2, offerId, orderId } = await offeredToNearest();

        const res = await declineOffer(courier1, offerId, { reason: 'too_far' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'declined', declineReason: 'too_far' });
        expect((await profileRow(courier1.id)).availability).toBe('online');
        const offers = await offersFor(orderId);
        expect(offers.map((o) => [o.courier_id, o.round, o.status])).toEqual([
            [courier1.id, 1, 'declined'],
            [courier2.id, 1, 'pending'],
        ]);
        expect((await dispatchRow(orderId)).dispatch_state).toBe('searching');
    });

    it('a decline is an answer: the missed-offers count starts again', async () => {
        const { courier1, offerId } = await offeredToNearest();
        await setMissedOffers(courier1.id, 1);

        await declineOffer(courier1, offerId);

        expect((await profileRow(courier1.id)).consecutive_missed_offers).toBe(0);
    });

    it('the customer sees no change: still "finding a courier" (status and dispatch state as before)', async () => {
        const { courier1, offerId, orderId, customer } = await offeredToNearest();

        await declineOffer(courier1, offerId);

        const view = await getCustomerOrder(customer.user.id, orderId);
        expect(view).toMatchObject({ status: 'ready_for_pickup', dispatchState: 'searching' });
    });
});

describe('the same tap when the offer is no longer pending', () => {
    it('declined already by me: 200 again (idempotent), no third offer', async () => {
        const { courier1, offerId, orderId } = await offeredToNearest();
        await declineOffer(courier1, offerId);

        const again = await declineOffer(courier1, offerId);

        expect(again.status).toBe(200);
        expect(await offersFor(orderId)).toHaveLength(2);
    });

    it('expired: 409 OFFER_CLOSED {offerStatus: expired}', async () => {
        const { courier1, offerId } = await offeredToNearest();
        await passOfferDeadline(offerId);
        await expireTimedOutOffers();

        const res = await declineOffer(courier1, offerId);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'OFFER_CLOSED', details: { offerStatus: 'expired' } });
    });

    it('withdrawn (the restaurant cancelled meanwhile): 409 OFFER_CLOSED {offerStatus: withdrawn}', async () => {
        const courier = await createCourier();
        const { orderId, owner } = await acceptedOrder();
        await pool.query(`UPDATE orders SET dispatch_after = now() - interval '1 second' WHERE id = $1`, [orderId]);
        await dispatchDueOrders();
        const offer = (await pendingOfferOf(courier.id))!;
        await ownerCancel(orderId, owner);

        const res = await declineOffer(courier, offer.id);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'OFFER_CLOSED', details: { offerStatus: 'withdrawn' } });
    });

    it('withdrawn by the customer (cancel while no courier is found) works the same way', async () => {
        const courier = await createCourier();
        const order = await readyOrder();
        await dispatchDueOrders();
        const offer = (await pendingOfferOf(courier.id))!;
        await pool.query(`UPDATE orders SET dispatch_state = 'no_courier' WHERE id = $1`, [order.orderId]);
        expect((await cancelWithBody(order.orderId, order.customer)).status).toBe(200);

        const res = await declineOffer(courier, offer.id);

        expect(res.body.error).toMatchObject({ code: 'OFFER_CLOSED', details: { offerStatus: 'withdrawn' } });
    });
});

describe('what happens next', () => {
    it('courier 2 accepts: assigned (happy path)', async () => {
        const { courier1, courier2, offerId, orderId } = await offeredToNearest();
        await declineOffer(courier1, offerId);
        const offer2 = (await pendingOfferOf(courier2.id))!;

        const res = await acceptOffer(courier2, offer2.id);

        expect(res.status).toBe(200);
        expect(await dispatchRow(orderId)).toMatchObject({ dispatch_state: 'assigned', courier_id: courier2.id });
    });

    it('nobody left within 10 km: no offer, the search goes on with a backoff', async () => {
        const { courier1, courier2, offerId, orderId } = await offeredToNearest();
        await declineOffer(courier1, offerId);
        await declineOffer(courier2, (await pendingOfferOf(courier2.id))!.id);

        const row = await dispatchRow(orderId);
        expect(row.dispatch_state).toBe('searching');
        expect(row.next_search_at!.getTime()).toBeGreaterThan(row.db_now.getTime());
        expect((await offersFor(orderId)).filter((o) => o.status === 'pending')).toHaveLength(0);
    });
});
