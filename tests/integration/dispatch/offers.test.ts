import { pool } from '../../helpers/db';
import { api } from '../../helpers/http';
import { BRASOV } from '../../helpers/catalog';
import { mockRoute } from '../../helpers/customer';
import { ownerCancel } from '../../helpers/restaurantOrders';
import { dispatchDueOrders } from '../../../src/services/dispatchService';
import { expireTimedOutOffers } from '../../../src/services/offerTimeout';
import {
    createCourier, moved, dispatchSettings, readyOrder, acceptedDueOrder, dispatchRow, offersFor, pendingOfferOf,
    currentOffer, acceptOffer, declineOffer, passOfferDeadline, type Courier,
} from '../../helpers/dispatch';

// M7 S3 (decline) and S5 (accept), and what a courier sees before saying yes (decision J: no customer data).

beforeEach(() => {
    mockRoute(3001);
});

// One courier 300 m from the restaurant with a pending offer for a ready order.
async function offered(courier?: Courier) {
    const me = courier ?? (await createCourier({ at: moved(BRASOV, 300) }));
    const order = await readyOrder();
    await dispatchDueOrders();
    const offer = await pendingOfferOf(me.id);
    if (!offer) throw new Error('no offer');
    return { courier: me, offerId: offer.id, ...order };
}

describe('GET /courier/offers/current', () => {
    it('{ offer: null } when there is none', async () => {
        const courier = await createCourier();
        const res = await currentOffer(courier);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ offer: null });
    });

    it('the restaurant and the distances, and no customer data at all', async () => {
        const { offer_timeout_s: timeoutS } = await dispatchSettings();
        const { courier, offerId } = await offered();

        const res = await currentOffer(courier);

        expect(res.status).toBe(200);
        const offer = res.body.offer;
        expect(Object.keys(offer).sort()).toEqual([
            'deliveryDistanceM', 'distanceToRestaurantM', 'estimatedReadyAt', 'expiresAt', 'id', 'itemCount',
            'readyAt', 'restaurant', 'secondsLeft',
        ]);
        expect(offer).toMatchObject({
            id: offerId,
            distanceToRestaurantM: 300,
            deliveryDistanceM: 3001,
            itemCount: 2,
            restaurant: { name: 'Pizza Test', lat: BRASOV.lat, lng: BRASOV.lng },
        });
        expect(Object.keys(offer.restaurant).sort()).toEqual(['address', 'lat', 'lng', 'name']);
        expect(offer.secondsLeft).toBeGreaterThanOrEqual(timeoutS - 3);
        expect(offer.secondsLeft).toBeLessThanOrEqual(timeoutS);
        // the customer's name and street (see addAddress / createUser) appear nowhere
        const text = JSON.stringify(res.body);
        expect(text).not.toContain('Test User');
        expect(text).not.toContain('Strada Lunga');
    });

    it('an offer past its deadline is not shown, even before the sweep runs', async () => {
        const { courier, offerId } = await offered();
        await passOfferDeadline(offerId);

        expect((await currentOffer(courier)).body).toEqual({ offer: null });
    });
});

describe('POST /courier/offers/:id/decline', () => {
    it('200 declined with the reason; the repeat is 200 too', async () => {
        const { courier, offerId } = await offered();

        const res = await declineOffer(courier, offerId, { reason: 'too_far' });
        const again = await declineOffer(courier, offerId, { reason: 'too_far' });

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ id: offerId, status: 'declined', declineReason: 'too_far' });
        expect(again.status).toBe(200);
        const stored = (await pool.query(`SELECT status, responded_at FROM order_offers WHERE id = $1`, [offerId])).rows[0];
        expect(stored.status).toBe('declined');
        expect(stored.responded_at).not.toBeNull();
    });

    it('the reason is optional (no body at all)', async () => {
        const { courier, offerId } = await offered();

        const res = await declineOffer(courier, offerId);

        expect(res.status).toBe(200);
        expect(res.body.declineReason).toBeNull();
    });

    it('400 for an unknown reason or an extra field', async () => {
        const { courier, offerId } = await offered();

        for (const body of [{ reason: 'went_offline' }, { reason: 'busy', note: 'x' }]) {
            const res = await declineOffer(courier, offerId, body);
            expect(res.status).toBe(400);
            expect(res.body.error.code).toBe('VALIDATION_ERROR');
        }
        expect((await pendingOfferOf(courier.id))?.id).toBe(offerId);
    });

    it('409 OFFER_CLOSED once the offer expired', async () => {
        const { courier, offerId } = await offered();
        await passOfferDeadline(offerId);
        await expireTimedOutOffers();

        const res = await declineOffer(courier, offerId);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'OFFER_CLOSED', details: { offerStatus: 'expired' } });
    });

    it('409 OFFER_CLOSED after accepting it', async () => {
        const { courier, offerId } = await offered();
        await acceptOffer(courier, offerId);

        const res = await declineOffer(courier, offerId);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'OFFER_CLOSED', details: { offerStatus: 'accepted' } });
    });

    it("404 OFFER_NOT_FOUND for another courier's offer; 400 for a malformed id", async () => {
        const { offerId } = await offered();
        const stranger = await createCourier({ at: moved(BRASOV, 20_000) });

        const res = await declineOffer(stranger, offerId);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('OFFER_NOT_FOUND');
        expect((await api().post('/courier/offers/abc/decline').set(stranger.headers)).status).toBe(400);
    });
});

describe('POST /courier/offers/:id/accept', () => {
    it('200: the courier is assigned, the offer accepted, and now the address is shown (never the phone)', async () => {
        const { courier, offerId, orderId } = await offered();
        const before = await dispatchRow(orderId);

        const res = await acceptOffer(courier, offerId);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            offerId, orderId, status: 'ready_for_pickup', version: before.version + 1,
            route: { distanceM: 3001, durationS: 600, polyline: 'abc' },
        });
        expect(res.body.orderCode).toMatch(/^BF-/);
        expect(res.body.order).toMatchObject({
            id: orderId,
            status: 'ready_for_pickup',
            customer: { firstName: 'Test', street: 'Strada Lunga 5', city: 'Brasov' },
            items: [{ name: 'Pizza', quantity: 2 }],
        });
        expect(Object.keys(res.body.order.customer).sort()).toEqual(['city', 'details', 'firstName', 'lat', 'lng', 'street']);

        const row = await dispatchRow(orderId);
        expect(row).toMatchObject({ courier_id: courier.id, dispatch_state: 'assigned', version: before.version + 1 });
        const [offer] = await offersFor(orderId);
        expect(offer.status).toBe('accepted');
        expect(offer.responded_at).not.toBeNull();
    });

    it('OSRM down: the accept still works, route is null', async () => {
        const { courier, offerId } = await offered();
        jest.mocked(fetch).mockImplementation(async () => {
            throw new TypeError('fetch failed');
        });

        const res = await acceptOffer(courier, offerId);

        expect(res.status).toBe(200);
        expect(res.body.route).toBeNull();
        expect(res.body.order).not.toBeNull();
    });

    it('a repeat by the same courier: 200 with the same order, nothing changes', async () => {
        const { courier, offerId, orderId } = await offered();
        const first = await acceptOffer(courier, offerId);

        const again = await acceptOffer(courier, offerId);

        expect(again.status).toBe(200);
        expect(again.body).toMatchObject({ orderId, version: first.body.version });
        expect((await dispatchRow(orderId)).version).toBe(first.body.version);
    });

    it('a late accept (deadline passed, sweep not run): 409 expired, nothing assigned; the sweep then expires it', async () => {
        const { courier, offerId, orderId } = await offered();
        await passOfferDeadline(offerId);

        const res = await acceptOffer(courier, offerId);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'OFFER_CLOSED', details: { offerStatus: 'expired' } });
        expect((await dispatchRow(orderId))).toMatchObject({ courier_id: null, dispatch_state: 'searching' });
        expect(await expireTimedOutOffers()).toBe(1);
        expect((await offersFor(orderId))[0].status).toBe('expired');
    });

    it('409 OFFER_CLOSED (withdrawn) after the restaurant cancelled the order (T11)', async () => {
        const courier = await createCourier();
        const { orderId, owner } = await acceptedDueOrder();
        await dispatchDueOrders();
        const offer = (await pendingOfferOf(courier.id))!;
        expect((await ownerCancel(orderId, owner)).status).toBe(200);

        const res = await acceptOffer(courier, offer.id);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'OFFER_CLOSED', details: { offerStatus: 'withdrawn' } });
        expect((await dispatchRow(orderId))).toMatchObject({ status: 'cancelled', courier_id: null });
    });

    it("404 OFFER_NOT_FOUND for another courier's offer", async () => {
        const { offerId, orderId } = await offered();
        const stranger = await createCourier({ at: moved(BRASOV, 20_000) });

        const res = await acceptOffer(stranger, offerId);

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('OFFER_NOT_FOUND');
        expect((await dispatchRow(orderId)).courier_id).toBeNull();
    });

    it('resolves an open no_courier incident', async () => {
        const { courier, offerId, orderId, shop } = await offered();
        await pool.query(
            `INSERT INTO order_incidents (order_id, restaurant_id, type, opened_by) VALUES ($1, $2, 'no_courier', 'system')`,
            [orderId, shop.restaurantId]
        );

        await acceptOffer(courier, offerId);

        const { rows } = await pool.query(`SELECT resolved_at, resolution_note FROM order_incidents WHERE order_id = $1`, [orderId]);
        expect(rows[0].resolved_at).not.toBeNull();
        expect(rows[0].resolution_note).toBe('a courier accepted');
    });
});
