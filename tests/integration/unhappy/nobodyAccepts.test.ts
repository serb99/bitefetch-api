import { BRASOV } from '../../helpers/catalog';
import { mockRoute } from '../../helpers/customer';
import { resetAccountTables } from '../../helpers/db';
import { outboxRows, statusHistory } from '../../helpers/payments';
import {
    createCourier, moved, readyOrder, dispatchRow, offersFor, pendingOfferOf, acceptOffer, declineOffer,
    passOfferDeadline, makeSearchDue, setOnline, profileRow,
} from '../../helpers/dispatch';
import {
    createAdmin, adminAction, orderVersion, passDispatchDeadline, ageDispatch, incidentsOf, openIncidentsOf, cancelWithBody,
} from '../../helpers/unhappy';
import { dispatchDueOrders, markNoCourierOrders } from '../../../src/services/dispatchService';
import { expireTimedOutOffers } from '../../../src/services/offerTimeout';
import { getCustomerOrder } from '../../../src/services/orderService';

// Unhappy path "Nobody accepts": no_courier after the deadline, the search goes on (accept from no_courier),
// the automatic second round, the admin (retry, cancel) and the customer (cancel while no courier is found).

beforeEach(() => {
    mockRoute(3001);
});

// A ready order searched once with nobody around: searching, round 1, no offer.
async function searchingOrder() {
    const order = await readyOrder();
    await dispatchDueOrders();
    return order;
}

// The same order after the no_courier sweep.
async function noCourierOrder() {
    const order = await searchingOrder();
    await passDispatchDeadline(order.orderId);
    await markNoCourierOrders();
    return order;
}

describe('dispatch_deadline passes', () => {
    it('searching → no_courier, version + 1, one no_courier incident opened by the system', async () => {
        const { orderId } = await searchingOrder();
        const before = await dispatchRow(orderId);
        await passDispatchDeadline(orderId);

        expect(await markNoCourierOrders()).toBe(1);

        const row = await dispatchRow(orderId);
        expect(row).toMatchObject({ status: 'ready_for_pickup', dispatch_state: 'no_courier', courier_id: null });
        expect(row.version).toBe(before.version + 1);
        expect(await openIncidentsOf(orderId)).toEqual([expect.objectContaining({ type: 'no_courier', opened_by: 'system' })]);
        expect((await statusHistory(orderId)).at(-1)!.to_status).toBe('ready_for_pickup'); // no status change
    });

    it('before the deadline nothing happens', async () => {
        const { orderId } = await searchingOrder();

        expect(await markNoCourierOrders()).toBe(0);

        expect((await dispatchRow(orderId)).dispatch_state).toBe('searching');
    });

    it('two sweepers at once: one transition, one incident', async () => {
        const { orderId } = await searchingOrder();
        await passDispatchDeadline(orderId);

        const [a, b] = await Promise.all([markNoCourierOrders(), markNoCourierOrders()]);

        expect(a + b).toBe(1);
        expect(await incidentsOf(orderId)).toHaveLength(1);
    });

    it('an assigned order is never moved to no_courier (assigned → no_courier is forbidden)', async () => {
        const courier = await createCourier();
        const { orderId } = await searchingOrder();
        const offer = (await pendingOfferOf(courier.id))!;
        await acceptOffer(courier, offer.id);
        await passDispatchDeadline(orderId);

        expect(await markNoCourierOrders()).toBe(0);

        expect((await dispatchRow(orderId)).dispatch_state).toBe('assigned');
    });

    it('a pending offer stays valid: the courier can still accept after no_courier, and the incident is resolved', async () => {
        const courier = await createCourier();
        const { orderId } = await searchingOrder();
        const offer = (await pendingOfferOf(courier.id))!;
        await passDispatchDeadline(orderId);
        await markNoCourierOrders();

        const res = await acceptOffer(courier, offer.id);

        expect(res.status).toBe(200);
        expect(await dispatchRow(orderId)).toMatchObject({ dispatch_state: 'assigned', courier_id: courier.id });
        expect(await openIncidentsOf(orderId)).toEqual([]);
    });

    it('the customer sees dispatchState no_courier (the web shows Cancel)', async () => {
        const { orderId, customer } = await noCourierOrder();

        expect((await getCustomerOrder(customer.user.id, orderId)).dispatchState).toBe('no_courier');
    });
});

describe('the search goes on: a courier becomes free', () => {
    it('a courier going online is offered the no_courier order at once (kick); accept → assigned, incident resolved', async () => {
        const { orderId } = await noCourierOrder();
        const courier = await createCourier({ online: false });

        expect((await setOnline(courier, true)).status).toBe(200);

        const offer = await pendingOfferOf(courier.id);
        expect(offer?.order_id).toBe(orderId);
        expect((await acceptOffer(courier, offer!.id)).status).toBe(200);
        expect(await dispatchRow(orderId)).toMatchObject({ dispatch_state: 'assigned', courier_id: courier.id });
        expect((await incidentsOf(orderId))[0]).toMatchObject({ type: 'no_courier', resolution_note: 'a courier accepted' });
    });
});

describe('one automatic second round after 5 min', () => {
    // Courier B (nearest) lets the offer expire, courier A declines: nobody left in round 1.
    async function roundOneExhausted() {
        const courierA = await createCourier({ at: moved(BRASOV, 600) });
        const courierB = await createCourier({ at: moved(BRASOV, 200) });
        const order = await searchingOrder();
        await passOfferDeadline((await pendingOfferOf(courierB.id))!.id);
        await expireTimedOutOffers();
        await makeSearchDue(order.orderId);
        await dispatchDueOrders();
        await declineOffer(courierA, (await pendingOfferOf(courierA.id))!.id);
        return { courierA, courierB, ...order };
    }

    it('after 5 min with nobody left: round 2 re-asks the decliner, not the courier who let it expire; deadline unchanged', async () => {
        const { courierA, courierB, orderId } = await roundOneExhausted();
        await ageDispatch(orderId, 301);
        const before = await dispatchRow(orderId);
        await makeSearchDue(orderId);

        await dispatchDueOrders();

        const row = await dispatchRow(orderId);
        expect(row.dispatch_round).toBe(2);
        expect(row.dispatch_deadline).toEqual(before.dispatch_deadline);
        expect(row.version).toBe(before.version);
        expect((await pendingOfferOf(courierA.id))).toMatchObject({ order_id: orderId, round: 2 });
        expect(await pendingOfferOf(courierB.id)).toBeUndefined();
    });

    it('not before 5 min: still round 1, backoff', async () => {
        const { orderId } = await roundOneExhausted();
        await ageDispatch(orderId, 200);
        await makeSearchDue(orderId);

        await dispatchDueOrders();

        expect((await dispatchRow(orderId)).dispatch_round).toBe(1);
    });

    it('at most once: when round 2 also runs dry the round stays 2', async () => {
        const { courierA, orderId } = await roundOneExhausted();
        await ageDispatch(orderId, 301);
        await makeSearchDue(orderId);
        await dispatchDueOrders();
        await declineOffer(courierA, (await pendingOfferOf(courierA.id))!.id);
        await makeSearchDue(orderId);

        await dispatchDueOrders();

        expect((await dispatchRow(orderId)).dispatch_round).toBe(2);
        expect((await offersFor(orderId)).filter((o) => o.status === 'pending')).toHaveLength(0);
    });

    it('not from no_courier: the deadline came first, the search goes on in round 1', async () => {
        const { orderId } = await roundOneExhausted();
        await ageDispatch(orderId, 301);
        await passDispatchDeadline(orderId);
        await markNoCourierOrders();
        await makeSearchDue(orderId);

        await dispatchDueOrders();

        expect(await dispatchRow(orderId)).toMatchObject({ dispatch_state: 'no_courier', dispatch_round: 1 });
    });
});

describe('the admin decides', () => {
    it('retry: searching again, round + 1, a new 15 min deadline, incident resolved, a free courier offered at once', async () => {
        const admin = await createAdmin();
        const { orderId } = await noCourierOrder();
        const courier = await createCourier(); // straight in the database: no kick, so no offer before the retry
        const before = await dispatchRow(orderId);

        const res = await adminAction(admin, orderId, 'retry-dispatch', { version: before.version });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ dispatchState: 'searching', dispatchRound: 2, version: before.version + 1 });
        const row = await dispatchRow(orderId);
        const deadlineInS = (row.dispatch_deadline!.getTime() - row.db_now.getTime()) / 1000;
        expect(deadlineInS).toBeGreaterThan(890);
        expect(deadlineInS).toBeLessThanOrEqual(900);
        expect(await incidentsOf(orderId)).toEqual([
            expect.objectContaining({ type: 'no_courier', resolved_by: admin.id, resolution_note: 'the admin started a new courier search' }),
        ]);
        expect(await pendingOfferOf(courier.id)).toMatchObject({ order_id: orderId, round: 2 });
    });

    it('retry, and the round fails again: a NEW incident', async () => {
        const admin = await createAdmin();
        const { orderId } = await noCourierOrder();
        await adminAction(admin, orderId, 'retry-dispatch', { version: await orderVersion(orderId) });
        await passDispatchDeadline(orderId);

        await markNoCourierOrders();

        const all = await incidentsOf(orderId);
        expect(all).toHaveLength(2);
        expect(all[1]).toMatchObject({ type: 'no_courier', resolved_at: null });
    });

    it('retry with a stale version (a courier accepted meanwhile): 409 VERSION_CONFLICT, nothing changes', async () => {
        const admin = await createAdmin();
        const courier = await createCourier();
        const { orderId } = await searchingOrder();
        const offer = (await pendingOfferOf(courier.id))!;
        await passDispatchDeadline(orderId);
        await markNoCourierOrders();
        const seen = await orderVersion(orderId);
        await acceptOffer(courier, offer.id);

        const res = await adminAction(admin, orderId, 'retry-dispatch', { version: seen });

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { version: seen + 1 } });
        expect((await dispatchRow(orderId)).dispatch_state).toBe('assigned');
    });

    it('retry while still searching: 409 ORDER_STATUS_CHANGED with the dispatch state', async () => {
        const admin = await createAdmin();
        const { orderId } = await searchingOrder();

        const res = await adminAction(admin, orderId, 'retry-dispatch', { version: await orderVersion(orderId) });

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'ORDER_STATUS_CHANGED', details: { dispatchState: 'searching' } });
    });

    it('two admins retry with the same version: one 200, one 409', async () => {
        const admin1 = await createAdmin();
        const admin2 = await createAdmin();
        const { orderId } = await noCourierOrder();
        const version = await orderVersion(orderId);

        const results = await Promise.all([
            adminAction(admin1, orderId, 'retry-dispatch', { version }),
            adminAction(admin2, orderId, 'retry-dispatch', { version }),
        ]);

        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect((await dispatchRow(orderId)).dispatch_round).toBe(2);
    });

    it('admin cancel: cancelled by the admin, pending offer withdrawn, void queued, incident resolved', async () => {
        const admin = await createAdmin();
        const courier = await createCourier();
        const { orderId } = await searchingOrder();
        const offer = (await pendingOfferOf(courier.id))!;
        await passDispatchDeadline(orderId);
        await markNoCourierOrders();

        const res = await adminAction(admin, orderId, 'cancel', { reason: 'no courier for 20 min', version: await orderVersion(orderId) });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'cancelled', cancelledBy: 'admin', cancelReason: 'admin_cancelled', cancelNote: 'no courier for 20 min' });
        expect((await offersFor(orderId)).find((o) => o.id === offer.id)!.status).toBe('withdrawn');
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(1);
        expect(await openIncidentsOf(orderId)).toEqual([]);
        expect((await statusHistory(orderId)).at(-1)).toMatchObject({ to_status: 'cancelled', actor: `admin:${admin.id}` });
    });
});

describe('the customer cancels while no courier is found', () => {
    it('cancelled by the customer, reason no_courier, offer withdrawn, incident resolved, one void', async () => {
        const courier = await createCourier();
        const order = await searchingOrder();
        const offer = (await pendingOfferOf(courier.id))!;
        await passDispatchDeadline(order.orderId);
        await markNoCourierOrders();

        const res = await cancelWithBody(order.orderId, order.customer, { note: 'waited too long' });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'cancelled', cancelReason: 'no_courier', cancelNote: 'waited too long' });
        expect((await offersFor(order.orderId)).find((o) => o.id === offer.id)!.status).toBe('withdrawn');
        expect(await openIncidentsOf(order.orderId)).toEqual([]);
        expect(await outboxRows(order.orderId, 'payment.void')).toHaveLength(1);
        expect((await profileRow(courier.id)).availability).toBe('online');
    });

    it('while still searching: 409 ORDER_NOT_CANCELLABLE (only support can cancel)', async () => {
        const order = await searchingOrder();

        const res = await cancelWithBody(order.orderId, order.customer);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({
            code: 'ORDER_NOT_CANCELLABLE', details: { status: 'ready_for_pickup', dispatchState: 'searching' },
        });
    });

    it('customer cancel vs a courier accept at the same moment: exactly one wins, the database matches the winner', async () => {
        for (let i = 0; i < 6; i++) {
            if (i > 0) await resetAccountTables();
            mockRoute(3001);
            const courier = await createCourier();
            const order = await searchingOrder();
            const offer = (await pendingOfferOf(courier.id))!;
            await passDispatchDeadline(order.orderId);
            await markNoCourierOrders();

            const [cancelled, accepted] = await Promise.all([
                cancelWithBody(order.orderId, order.customer),
                acceptOffer(courier, offer.id),
            ]);

            expect([cancelled.status, accepted.status].sort()).toEqual([200, 409]);
            const row = await dispatchRow(order.orderId);
            if (cancelled.status === 200) {
                expect(row).toMatchObject({ status: 'cancelled', courier_id: null });
                expect(accepted.body.error.code).toMatch(/OFFER_CLOSED|ORDER_STATUS_CHANGED/);
                expect(await outboxRows(order.orderId, 'payment.void')).toHaveLength(1);
            } else {
                expect(row).toMatchObject({ status: 'ready_for_pickup', dispatch_state: 'assigned', courier_id: courier.id });
                expect(cancelled.body.error).toMatchObject({ code: 'ORDER_NOT_CANCELLABLE', message: 'A courier just accepted this order' });
                expect(await outboxRows(order.orderId, 'payment.void')).toHaveLength(0);
            }
        }
    }, 30_000);
});
