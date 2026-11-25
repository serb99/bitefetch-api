import { BRASOV } from '../../helpers/catalog';
import { api } from '../../helpers/http';
import { mockRoute } from '../../helpers/customer';
import { createUser } from '../../helpers/users';
import { bearer } from '../../helpers/catalog';
import { outboxRows, statusHistory } from '../../helpers/payments';
import { acceptedOrder, ready } from '../../helpers/restaurantOrders';
import {
    createCourier, moved, assignedOrder, pickedUpOrder, readyOrder, dispatchRow, offersFor, pendingOfferOf, pickup,
    setPosition,
} from '../../helpers/dispatch';
import {
    createAdmin, adminGetOrder, adminAction, decideCancelRequest, requestCancel, reportProblem, orderVersion, ageIncident,
    incidentsOf, openIncidentsOf, cancelRequestsOf,
} from '../../helpers/unhappy';

// Admin actions on one order (the lists come later): decide an owner's cancel request, cancel,
// mark picked up / delivered for the courier, reassign. Retry dispatch is in nobodyAccepts. Every action needs the version the
// admin saw (409 VERSION_CONFLICT otherwise) and is audited as admin:{id}.

beforeEach(() => {
    mockRoute(3001);
});

describe('access', () => {
    it('401 without a token; 403 for a customer, an owner or a courier', async () => {
        const order = await readyOrder();
        const courier = await createCourier();

        expect((await api().get(`/admin/orders/${order.orderId}`)).status).toBe(401);
        expect((await api().get(`/admin/orders/${order.orderId}`).set(order.customer.headers)).status).toBe(403);
        expect((await api().get(`/admin/orders/${order.orderId}`).set(order.owner)).status).toBe(403);
        expect((await api().get(`/admin/orders/${order.orderId}`).set(courier.headers)).status).toBe(403);
    });

    it('an admin token without a live session (logged out) is refused', async () => {
        const order = await readyOrder();
        const admin = await createUser({ role: 'admin' });

        const res = await api().get(`/admin/orders/${order.orderId}`).set(bearer(admin));

        expect(res.status).toBe(401);
    });

    it('GET /admin/orders/:id: the order with version, dispatch state, incidents and cancel requests; 404 unknown', async () => {
        const admin = await createAdmin();
        const order = await readyOrder();

        const res = await adminGetOrder(admin, order.orderId);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            id: order.orderId, status: 'ready_for_pickup', version: await orderVersion(order.orderId),
            dispatchState: 'not_started', restaurant: { id: order.shop.restaurantId }, incidents: [], cancelRequests: [],
        });
        expect((await adminGetOrder(admin, '999999')).status).toBe(404);
    });

    it('400: reason missing or too short, version missing, unknown fields', async () => {
        const admin = await createAdmin();
        const { orderId } = await readyOrder();
        const version = await orderVersion(orderId);

        expect((await adminAction(admin, orderId, 'cancel', { version })).status).toBe(400);
        expect((await adminAction(admin, orderId, 'cancel', { reason: 'no', version })).status).toBe(400);
        expect((await adminAction(admin, orderId, 'cancel', { reason: 'because' })).status).toBe(400);
        expect((await adminAction(admin, orderId, 'retry-dispatch', { version, force: true })).status).toBe(400);
    });
});

describe('admin cancel (any non-terminal status)', () => {
    it('after pickup (only the admin can): cancelled, voided (never charged), incidents resolved, audited', async () => {
        const admin = await createAdmin();
        const courier = await createCourier();
        const { orderId } = await pickedUpOrder(courier);
        await reportProblem(courier, orderId, { category: 'wrong_or_missing_items' });

        const res = await adminAction(admin, orderId, 'cancel', { reason: 'food spilled', version: await orderVersion(orderId) });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'cancelled', cancelledBy: 'admin', cancelNote: 'food spilled', courierId: courier.id });
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(1);
        expect(await outboxRows(orderId, 'payment.capture')).toHaveLength(0);
        expect(await openIncidentsOf(orderId)).toEqual([]);
        expect((await statusHistory(orderId)).at(-1)).toMatchObject({ from_status: 'picked_up', to_status: 'cancelled', actor: `admin:${admin.id}` });
    });

    it('before acceptance (placed) and with an assigned courier: the courier is released', async () => {
        const admin = await createAdmin();
        const courier = await createCourier();
        const { orderId } = await assignedOrder(courier);

        await adminAction(admin, orderId, 'cancel', { reason: 'customer called support', version: await orderVersion(orderId) });

        expect(await dispatchRow(orderId)).toMatchObject({ status: 'cancelled', courier_id: null });
    });

    it('409 VERSION_CONFLICT on a stale version; 409 for a terminal order', async () => {
        const admin = await createAdmin();
        const { orderId, owner } = await acceptedOrder();
        const seen = await orderVersion(orderId);
        await ready(orderId, owner);

        const stale = await adminAction(admin, orderId, 'cancel', { reason: 'too late', version: seen });
        expect(stale.status).toBe(409);
        expect(stale.body.error).toMatchObject({ code: 'VERSION_CONFLICT', details: { status: 'ready_for_pickup', version: seen + 1 } });

        await adminAction(admin, orderId, 'cancel', { reason: 'first time', version: seen + 1 });
        const terminal = await adminAction(admin, orderId, 'cancel', { reason: 'again', version: seen + 2 });
        expect(terminal.status).toBe(409);
        expect(terminal.body.error).toMatchObject({ code: 'ORDER_STATUS_CHANGED', details: { status: 'cancelled' } });
    });
});

describe('the admin acts for the courier', () => {
    it('mark picked up: no location check (the courier is 5 km away), ETA set, audited', async () => {
        const admin = await createAdmin();
        const courier = await createCourier();
        const { orderId } = await assignedOrder(courier);
        await setPosition(courier.id, moved(BRASOV, 5000));

        const res = await adminAction(admin, orderId, 'mark-picked-up', { reason: 'courier app crashed', version: await orderVersion(orderId) });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'picked_up', courierId: courier.id });
        expect(res.body.estimatedDeliveryAt).not.toBeNull();
        expect((await statusHistory(orderId)).at(-1)).toMatchObject({ to_status: 'picked_up', actor: `admin:${admin.id}` });
    });

    it('mark picked up without a courier: 409', async () => {
        const admin = await createAdmin();
        const { orderId } = await readyOrder();

        const res = await adminAction(admin, orderId, 'mark-picked-up', { reason: 'nobody', version: await orderVersion(orderId) });

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('ORDER_STATUS_CHANGED');
    });

    it('mark picked up vs the courier\'s own pickup: whoever is first, the other one gets 409', async () => {
        const admin = await createAdmin();
        const courier = await createCourier();
        const { orderId } = await assignedOrder(courier);
        const seen = await orderVersion(orderId);
        await setPosition(courier.id, BRASOV);
        expect((await pickup(courier, orderId)).status).toBe(200);

        const res = await adminAction(admin, orderId, 'mark-picked-up', { reason: 'late', version: seen });

        expect(res.body.error.code).toBe('VERSION_CONFLICT');
    });

    it('mark delivered: delivered, capture queued, the courier free again', async () => {
        const admin = await createAdmin();
        const courier = await createCourier();
        const { orderId } = await pickedUpOrder(courier);

        const res = await adminAction(admin, orderId, 'mark-delivered', { reason: 'courier phone died at the door', version: await orderVersion(orderId) });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'delivered', deliveredAt: expect.any(String) });
        expect(await outboxRows(orderId, 'payment.capture')).toHaveLength(1);
        const next = await readyOrder();
        const { dispatchDueOrders } = await import('../../../src/services/dispatchService');
        await dispatchDueOrders();
        expect((await pendingOfferOf(courier.id))?.order_id).toBe(next.orderId);
    });

    it('customer unreachable reported 5 min ago → 409 CUSTOMER_WAIT_NOT_OVER; after 10 min → delivered, incident resolved', async () => {
        const admin = await createAdmin();
        const courier = await createCourier();
        const { orderId } = await pickedUpOrder(courier);
        const problem = await reportProblem(courier, orderId, { category: 'customer_unreachable' });
        await ageIncident(problem.body.id, 300);

        const early = await adminAction(admin, orderId, 'mark-delivered', { reason: 'nobody opens', version: await orderVersion(orderId) });
        expect(early.status).toBe(409);
        expect(early.body.error).toMatchObject({ code: 'CUSTOMER_WAIT_NOT_OVER', details: { waitS: 600 } });
        expect(early.body.error.details.secondsLeft).toBeGreaterThan(290);

        await ageIncident(problem.body.id, 601);
        const res = await adminAction(admin, orderId, 'mark-delivered', { reason: 'nobody opens', version: await orderVersion(orderId) });
        expect(res.status).toBe(200);
        expect(await incidentsOf(orderId)).toEqual([
            expect.objectContaining({ type: 'courier_problem', resolved_at: expect.any(Date) }),
        ]);
    });

    it('mark delivered on an order not picked up: 409', async () => {
        const admin = await createAdmin();
        const courier = await createCourier();
        const { orderId } = await assignedOrder(courier);

        const res = await adminAction(admin, orderId, 'mark-delivered', { reason: 'skip', version: await orderVersion(orderId) });

        expect(res.body.error).toMatchObject({ code: 'ORDER_STATUS_CHANGED', details: { status: 'ready_for_pickup' } });
    });
});

describe('reassign the courier (vehicle_issue before pickup)', () => {
    it('the courier is taken off, their offer withdrawn, the next courier offered; the problem is resolved', async () => {
        const admin = await createAdmin();
        const courier1 = await createCourier({ at: moved(BRASOV, 200) });
        const { orderId } = await assignedOrder(courier1);
        const courier2 = await createCourier({ at: moved(BRASOV, 800) });
        await reportProblem(courier1, orderId, { category: 'vehicle_issue', note: 'chain broke' });

        const res = await adminAction(admin, orderId, 'reassign-courier', { reason: 'vehicle issue', version: await orderVersion(orderId) });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ dispatchState: 'searching', courierId: null });
        const offers = await offersFor(orderId);
        expect(offers.map((o) => [o.courier_id, o.status])).toEqual([
            [courier1.id, 'withdrawn'],
            [courier2.id, 'pending'],
        ]);
        expect(await openIncidentsOf(orderId)).toEqual([]);
    });

    it('the old courier: pickup → 409 (lost the order), never offered this order again', async () => {
        const admin = await createAdmin();
        const courier1 = await createCourier();
        const { orderId } = await assignedOrder(courier1);
        await adminAction(admin, orderId, 'reassign-courier', { reason: 'too slow', version: await orderVersion(orderId) });
        await setPosition(courier1.id, BRASOV);

        const res = await pickup(courier1, orderId);

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('ORDER_STATUS_CHANGED');
        expect(await pendingOfferOf(courier1.id)).toBeUndefined();
    });

    it('409 when nobody is assigned; 409 VERSION_CONFLICT after the old courier picked up', async () => {
        const admin = await createAdmin();
        const courier = await createCourier();
        const { orderId } = await assignedOrder(courier);
        const seen = await orderVersion(orderId);
        await setPosition(courier.id, BRASOV);
        await pickup(courier, orderId);
        const late = await adminAction(admin, orderId, 'reassign-courier', { reason: 'too late', version: seen });
        expect(late.body.error.code).toBe('VERSION_CONFLICT');

        const waiting = await readyOrder(); // not dispatched yet: nobody assigned
        const none = await adminAction(admin, waiting.orderId, 'reassign-courier', { reason: 'x'.repeat(5), version: await orderVersion(waiting.orderId) });
        expect(none.body.error).toMatchObject({ code: 'ORDER_STATUS_CHANGED', details: { dispatchState: 'not_started' } });
    });
});

describe('the owner asks to cancel a ready order, the admin decides', () => {
    it('owner request: 201 pending; asking again → 200 with the same request; the order does not change', async () => {
        const { orderId, owner } = await readyOrder();

        const first = await requestCancel(orderId, owner, { reasonCode: 'out_of_stock', note: 'dropped the pizza' });
        const second = await requestCancel(orderId, owner, { reasonCode: 'too_busy' });

        expect(first.status).toBe(201);
        expect(first.body).toMatchObject({ orderId, status: 'pending', reasonCode: 'out_of_stock', note: 'dropped the pizza', version: 0 });
        expect(second.status).toBe(200);
        expect(second.body.id).toBe(first.body.id);
        expect((await dispatchRow(orderId)).status).toBe('ready_for_pickup');
    });

    it('owner request while accepted (cancel directly) or after pickup: 409', async () => {
        const accepted = await acceptedOrder();
        const res = await requestCancel(accepted.orderId, accepted.owner);
        expect(res.body.error).toMatchObject({ code: 'ORDER_STATUS_CHANGED', details: { status: 'accepted' } });

        const courier = await createCourier();
        const picked = await pickedUpOrder(courier);
        expect((await requestCancel(picked.orderId, picked.owner)).body.error.details).toEqual({ status: 'picked_up' });
    });

    it('approve: cancelled as by the restaurant with its reason, request approved by the admin, void, courier released', async () => {
        const admin = await createAdmin();
        const courier = await createCourier();
        const { orderId, owner } = await assignedOrder(courier);
        const request = (await requestCancel(orderId, owner, { reasonCode: 'kitchen_issue' })).body;

        const res = await decideCancelRequest(admin, request.id, 'approve', { version: request.version });

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ status: 'cancelled', cancelledBy: 'restaurant', cancelReason: 'kitchen_issue', courierId: null });
        expect(await cancelRequestsOf(orderId)).toEqual([
            expect.objectContaining({ status: 'approved', decided_by: admin.id, decided_at: expect.any(Date) }),
        ]);
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(1);
        expect((await statusHistory(orderId)).at(-1)).toMatchObject({ to_status: 'cancelled', actor: `admin:${admin.id}` });
    });

    it('reject: the request is closed, the order goes on', async () => {
        const admin = await createAdmin();
        const { orderId, owner } = await readyOrder();
        const request = (await requestCancel(orderId, owner)).body;

        const res = await decideCancelRequest(admin, request.id, 'reject', { version: request.version });

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('ready_for_pickup');
        expect((await cancelRequestsOf(orderId))[0]).toMatchObject({ status: 'rejected', decided_by: admin.id });
        expect(await outboxRows(orderId, 'payment.void')).toHaveLength(0);
    });

    it('the courier picks up first: the request is superseded and the admin gets 409 CANCEL_REQUEST_CLOSED', async () => {
        const admin = await createAdmin();
        const courier = await createCourier();
        const { orderId, owner } = await assignedOrder(courier);
        const request = (await requestCancel(orderId, owner)).body;
        await setPosition(courier.id, BRASOV);
        await pickup(courier, orderId);

        const res = await decideCancelRequest(admin, request.id, 'approve', { version: request.version });

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'CANCEL_REQUEST_CLOSED', details: { requestStatus: 'superseded', status: 'picked_up' } });
        expect((await dispatchRow(orderId)).status).toBe('picked_up');
    });

    it('a stale request version: 409 VERSION_CONFLICT; an unknown request: 404', async () => {
        const admin = await createAdmin();
        const { orderId, owner } = await readyOrder();
        const request = (await requestCancel(orderId, owner)).body;

        const stale = await decideCancelRequest(admin, request.id, 'approve', { version: request.version + 1 });
        expect(stale.body.error.code).toBe('VERSION_CONFLICT');

        const missing = await decideCancelRequest(admin, '999999', 'approve', { version: 1 });
        expect(missing.status).toBe(404);
        expect(missing.body.error.code).toBe('CANCEL_REQUEST_NOT_FOUND');
    });

    it('two admins decide at once: one 200, one 409', async () => {
        const admin1 = await createAdmin();
        const admin2 = await createAdmin();
        const { orderId, owner } = await readyOrder();
        const request = (await requestCancel(orderId, owner)).body;

        const results = await Promise.all([
            decideCancelRequest(admin1, request.id, 'approve', { version: request.version }),
            decideCancelRequest(admin2, request.id, 'reject', { version: request.version }),
        ]);

        expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
        expect((await cancelRequestsOf(orderId))[0].status).not.toBe('pending');
    });
});
