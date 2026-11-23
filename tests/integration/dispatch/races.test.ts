import { setTimeout as sleep } from 'node:timers/promises';
import { pool, resetAccountTables } from '../../helpers/db';
import { BRASOV } from '../../helpers/catalog';
import { mockRoute } from '../../helpers/customer';
import { outboxRows } from '../../helpers/payments';
import { ownerCancel } from '../../helpers/restaurantOrders';
import { dispatchDueOrders } from '../../../src/services/dispatchService';
import { expireTimedOutOffers } from '../../../src/services/offerTimeout';
import {
    createCourier, moved, readyOrder, acceptedDueOrder, pickedUpOrder, dispatchRow, offersFor, offersOf,
    allPendingOffers, pendingOfferOf, profileRow, acceptOffer, declineOffer, setOnline, pickup, deliver,
    setPosition, passOfferDeadline,
} from '../../helpers/dispatch';

// M7: two actors at the same moment. Each race runs REPEAT times (the interleaving differs from run to run)
// and checks that exactly one side wins, the database matches the winner, and nothing fails with a deadlock
// (40P01) or a 500. Lock order everywhere: courier's users row → order → offer.

const REPEAT = 8;

beforeEach(() => {
    mockRoute(3001);
});

async function repeat(run: () => Promise<void>): Promise<void> {
    for (let i = 0; i < REPEAT; i++) {
        if (i > 0) await resetAccountTables(); // couriers from the previous run would get the offers
        await run();
    }
}

// A service call that may throw: returns the error instead, so Promise.all sees both sides.
async function settle<T>(promise: Promise<T>): Promise<{ value?: T; error?: { code?: string; message: string } }> {
    try {
        return { value: await promise };
    } catch (err) {
        const e = err as { code?: string; message: string };
        return { error: { code: e.code, message: e.message } };
    }
}

function expectNoServerError(...statuses: number[]): void {
    for (const status of statuses) expect(status).toBeLessThan(500);
}

// A courier 300 m away with a pending offer for a ready order.
async function offered() {
    const courier = await createCourier({ at: moved(BRASOV, 300) });
    const order = await readyOrder();
    await dispatchDueOrders();
    const offer = await pendingOfferOf(courier.id);
    if (!offer) throw new Error('no offer');
    return { courier, offerId: offer.id, ...order };
}

describe('races in dispatch', () => {
    it('S5 accept vs S4 expiry at the deadline: accepted and assigned, or expired and unassigned, never both', async () => {
        await repeat(async () => {
            const { courier, offerId, orderId } = await offered();
            await pool.query(
                `UPDATE order_offers SET expires_at = now() + interval '150 milliseconds' WHERE id = $1`,
                [offerId]
            );
            await sleep(140);

            const [accepted, swept] = await Promise.all([acceptOffer(courier, offerId), settle(expireTimedOutOffers())]);

            expectNoServerError(accepted.status);
            expect(swept.error).toBeUndefined();
            await sleep(50);
            await expireTimedOutOffers(); // a 409 left the offer pending if the sweep looked a moment too early
            const [offer] = await offersFor(orderId);
            const row = await dispatchRow(orderId);
            if (accepted.status === 200) {
                expect(offer.status).toBe('accepted');
                expect(row.courier_id).toBe(courier.id);
            } else {
                expect(accepted.body.error).toMatchObject({ code: 'OFFER_CLOSED', details: { offerStatus: 'expired' } });
                expect(offer.status).toBe('expired');
                expect(row.courier_id).toBeNull();
            }
        });
    });

    it('S5 accept vs T11 restaurant cancel: the cancel always wins in the end, the offer matches', async () => {
        await repeat(async () => {
            const courier = await createCourier();
            const { orderId, owner } = await acceptedDueOrder();
            await dispatchDueOrders();
            const offer = (await pendingOfferOf(courier.id))!;

            const [accepted, cancelled] = await Promise.all([acceptOffer(courier, offer.id), ownerCancel(orderId, owner)]);

            expectNoServerError(accepted.status, cancelled.status);
            expect(cancelled.status).toBe(200);
            const row = await dispatchRow(orderId);
            expect(row).toMatchObject({ status: 'cancelled', courier_id: null });
            const [stored] = await offersFor(orderId);
            if (accepted.status === 200) {
                expect(stored.status).toBe('accepted'); // accepted first, then the restaurant cancelled
            } else {
                expect(accepted.body.error).toMatchObject({ code: 'OFFER_CLOSED', details: { offerStatus: 'withdrawn' } });
                expect(stored.status).toBe('withdrawn');
            }
            expect(await allPendingOffers()).toHaveLength(0);
        });
    });

    it('two dispatch passes at once with two orders and one courier: one pending offer, no error', async () => {
        await repeat(async () => {
            const courier = await createCourier();
            await readyOrder();
            await readyOrder();

            const results = await Promise.all([settle(dispatchDueOrders()), settle(dispatchDueOrders())]);

            for (const r of results) expect(r.error).toBeUndefined();
            const pending = await allPendingOffers();
            expect(pending).toHaveLength(1);
            expect(pending[0].courier_id).toBe(courier.id);
        });
    });

    it('S3 decline vs S4 expiry on an overdue offer: declined or expired, and the answer matches', async () => {
        await repeat(async () => {
            const { courier, offerId, orderId } = await offered();
            await passOfferDeadline(offerId);

            const [declined, swept] = await Promise.all([declineOffer(courier, offerId, { reason: 'busy' }), settle(expireTimedOutOffers())]);

            expectNoServerError(declined.status);
            expect(swept.error).toBeUndefined();
            const [offer] = await offersFor(orderId);
            if (declined.status === 200) {
                expect(offer.status).toBe('declined');
                expect(swept.value).toBe(0);
            } else {
                expect(declined.body.error).toMatchObject({ code: 'OFFER_CLOSED', details: { offerStatus: 'expired' } });
                expect(offer.status).toBe('expired');
                expect(swept.value).toBe(1);
            }
        });
    });

    it('going offline vs a dispatch pass: in the end the courier is offline with no pending offer', async () => {
        await repeat(async () => {
            const courier = await createCourier();
            const { orderId } = await readyOrder();

            const [offline, dispatched] = await Promise.all([setOnline(courier, false), settle(dispatchDueOrders())]);

            expect(offline.status).toBe(200);
            expect(dispatched.error).toBeUndefined();
            expect((await profileRow(courier.id)).availability).toBe('offline');
            expect(await pendingOfferOf(courier.id)).toBeUndefined();
            // if an offer was made in between, it was given back
            for (const offer of await offersFor(orderId)) {
                expect(offer).toMatchObject({ status: 'declined', decline_reason: 'went_offline' });
            }
        });
    });

    it('going offline vs accepting the open offer: either assigned, or the offer was given back; never both', async () => {
        await repeat(async () => {
            const { courier, offerId, orderId } = await offered();

            const [offline, accepted] = await Promise.all([setOnline(courier, false), acceptOffer(courier, offerId)]);

            expectNoServerError(offline.status, accepted.status);
            const [offer] = await offersFor(orderId);
            const row = await dispatchRow(orderId);
            if (accepted.status === 200) {
                expect(offer.status).toBe('accepted');
                expect(row.courier_id).toBe(courier.id);
            } else {
                expect(accepted.body.error).toMatchObject({ code: 'OFFER_CLOSED', details: { offerStatus: 'declined' } });
                expect(offer).toMatchObject({ status: 'declined', decline_reason: 'went_offline' });
                expect(row.courier_id).toBeNull();
            }
        });
    });

    it('the same courier taps accept twice at once: both 200, one assignment, version + 1 once', async () => {
        await repeat(async () => {
            const { courier, offerId, orderId } = await offered();
            const before = await dispatchRow(orderId);

            const [first, second] = await Promise.all([acceptOffer(courier, offerId), acceptOffer(courier, offerId)]);

            expect([first.status, second.status]).toEqual([200, 200]);
            const row = await dispatchRow(orderId);
            expect(row).toMatchObject({ courier_id: courier.id, version: before.version + 1 });
            expect(await offersOf(courier.id)).toHaveLength(1);
        });
    });

    it('T13 double tap at once: both 200, one outbox capture', async () => {
        await repeat(async () => {
            const courier = await createCourier();
            const { orderId, door } = await pickedUpOrder(courier);
            await setPosition(courier.id, door);

            const [first, second] = await Promise.all([deliver(courier, orderId), deliver(courier, orderId)]);

            expect([first.status, second.status]).toEqual([200, 200]);
            expect(await outboxRows(orderId, 'payment.capture')).toHaveLength(1);
        });
    });

    it('T12 pickup vs T11 restaurant cancel: exactly one wins', async () => {
        await repeat(async () => {
            const courier = await createCourier();
            const { orderId, owner } = await acceptedDueOrder();
            await dispatchDueOrders();
            await acceptOffer(courier, (await pendingOfferOf(courier.id))!.id);
            await setPosition(courier.id, BRASOV);

            const [picked, cancelled] = await Promise.all([pickup(courier, orderId), ownerCancel(orderId, owner)]);

            expect([picked.status, cancelled.status].sort()).toEqual([200, 409]);
            const row = await dispatchRow(orderId);
            if (picked.status === 200) {
                expect(row.status).toBe('picked_up');
                expect(cancelled.body.error).toMatchObject({ code: 'ORDER_STATUS_CHANGED', details: { status: 'picked_up' } });
                expect(await outboxRows(orderId, 'payment.void')).toHaveLength(0);
            } else {
                expect(row.status).toBe('cancelled');
                expect(picked.body.error).toMatchObject({ code: 'ORDER_STATUS_CHANGED', details: { status: 'cancelled' } });
                expect(await outboxRows(orderId, 'payment.void')).toHaveLength(1);
            }
        });
    });
});
