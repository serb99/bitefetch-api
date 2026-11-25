import { pool } from '../../helpers/db';
import { mockRoute } from '../../helpers/customer';
import { acceptedOrder, ready, ownerCancel } from '../../helpers/restaurantOrders';
import {
    createCourier, assignedOrder, pickedUpOrder, setPosition, deliver, dispatchRow, readyOrder,
} from '../../helpers/dispatch';
import { ageReadyTime, ageDeliveryEta, incidentsOf, openIncidentsOf, reportProblem } from '../../helpers/unhappy';
import { openKitchenLateIncidents, openDeliveryOverdueIncidents } from '../../../src/services/incidentSweeps';

// Incidents. None of them changes the order status.
// kitchen_late and delivery_overdue are opened by the incident-sweep job; courier_problem by the
// courier; capture_failed is tested in paymentFails, no_courier in nobodyAccepts, restaurant_unresponsive in restaurantOrders.

beforeEach(() => {
    mockRoute(3001);
});

describe('kitchen_late: still accepted 10 min after estimated_ready_at', () => {
    it('opens one incident; the order is not touched', async () => {
        const { orderId } = await acceptedOrder();
        await ageReadyTime(orderId, 601);
        const before = await dispatchRow(orderId);

        expect(await openKitchenLateIncidents()).toBe(1);

        expect(await openIncidentsOf(orderId)).toEqual([expect.objectContaining({ type: 'kitchen_late', opened_by: 'system' })]);
        const after = await dispatchRow(orderId);
        expect(after.status).toBe('accepted');
        expect(after.version).toBe(before.version);
    });

    it('not before the 10 minutes', async () => {
        const { orderId } = await acceptedOrder();
        await ageReadyTime(orderId, 590);

        expect(await openKitchenLateIncidents()).toBe(0);
    });

    it('once per order: a second sweep, or one after the admin resolved it, does not open another', async () => {
        const { orderId } = await acceptedOrder();
        await ageReadyTime(orderId, 601);
        await openKitchenLateIncidents();
        expect(await openKitchenLateIncidents()).toBe(0);

        await pool.query(`UPDATE order_incidents SET resolved_at = now() WHERE order_id = $1`, [orderId]);

        expect(await openKitchenLateIncidents()).toBe(0);
        expect(await incidentsOf(orderId)).toHaveLength(1);
    });

    it('marking it ready resolves it', async () => {
        const { orderId, owner } = await acceptedOrder();
        await ageReadyTime(orderId, 601);
        await openKitchenLateIncidents();

        await ready(orderId, owner);

        expect(await incidentsOf(orderId)).toEqual([
            expect.objectContaining({ type: 'kitchen_late', resolution_note: 'marked ready by the restaurant', resolved_at: expect.any(Date) }),
        ]);
    });

    it('a ready order is never late in the kitchen', async () => {
        const { orderId, owner } = await acceptedOrder();
        await ready(orderId, owner);
        await ageReadyTime(orderId, 601);

        expect(await openKitchenLateIncidents()).toBe(0);
    });

    it('sweep vs ready at the same moment: never an open incident on a ready order', async () => {
        for (let i = 0; i < 6; i++) {
            const { orderId, owner } = await acceptedOrder();
            await ageReadyTime(orderId, 601);

            await Promise.all([openKitchenLateIncidents(), ready(orderId, owner)]);

            expect((await dispatchRow(orderId)).status).toBe('ready_for_pickup');
            expect(await openIncidentsOf(orderId)).toEqual([]);
        }
    }, 20_000);

    it('any cancel resolves it (owner cancel)', async () => {
        const { orderId, owner } = await acceptedOrder();
        await ageReadyTime(orderId, 601);
        await openKitchenLateIncidents();

        await ownerCancel(orderId, owner);

        expect(await openIncidentsOf(orderId)).toEqual([]);
    });
});

describe('delivery_overdue: picked_up 30 min after estimated_delivery_at', () => {
    it('opens one incident, no transition; the delivery resolves it', async () => {
        const courier = await createCourier();
        const { orderId, door } = await pickedUpOrder(courier);
        await ageDeliveryEta(orderId, 1801);

        expect(await openDeliveryOverdueIncidents()).toBe(1);
        expect((await dispatchRow(orderId)).status).toBe('picked_up');

        await setPosition(courier.id, door);
        await deliver(courier, orderId);
        expect(await incidentsOf(orderId)).toEqual([
            expect.objectContaining({ type: 'delivery_overdue', resolution_note: 'delivered', resolved_at: expect.any(Date) }),
        ]);
    });

    it('not before the 30 minutes', async () => {
        const courier = await createCourier();
        const { orderId } = await pickedUpOrder(courier);
        await ageDeliveryEta(orderId, 1790);

        expect(await openDeliveryOverdueIncidents()).toBe(0);
    });
});

describe('courier_problem: POST /courier/orders/:id/problems', () => {
    it('201 with the category and note; opened by the courier; the order does not change', async () => {
        const courier = await createCourier();
        const { orderId } = await assignedOrder(courier);
        const before = await dispatchRow(orderId);

        const res = await reportProblem(courier, orderId, { category: 'vehicle_issue', note: 'flat tyre' });

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ orderId, category: 'vehicle_issue', details: 'flat tyre', openedAt: expect.any(String) });
        expect(await openIncidentsOf(orderId)).toEqual([
            expect.objectContaining({ type: 'courier_problem', category: 'vehicle_issue', opened_by: 'courier', opened_by_user_id: courier.id }),
        ]);
        const after = await dispatchRow(orderId);
        expect(after.version).toBe(before.version);
        expect(after.status).toBe(before.status);
    });

    it('reporting again while one is open: 200 with the open one (one open per order)', async () => {
        const courier = await createCourier();
        const { orderId } = await assignedOrder(courier);
        const first = await reportProblem(courier, orderId, { category: 'customer_unreachable' });

        const second = await reportProblem(courier, orderId, { category: 'other', note: 'still nobody' });

        expect(second.status).toBe(200);
        expect(second.body.id).toBe(first.body.id);
        expect(await incidentsOf(orderId)).toHaveLength(1);
    });

    it('400: a note is required for other; an unknown category; an unknown field', async () => {
        const courier = await createCourier();
        const { orderId } = await assignedOrder(courier);

        expect((await reportProblem(courier, orderId, { category: 'other' })).status).toBe(400);
        expect((await reportProblem(courier, orderId, { category: 'aliens' })).status).toBe(400);
        expect((await reportProblem(courier, orderId, { category: 'vehicle_issue', orderStatus: 'cancelled' })).status).toBe(400);
        expect(await incidentsOf(orderId)).toEqual([]);
    });

    it('404 for an order the courier never had; 409 for a delivered one', async () => {
        const courier = await createCourier();
        const { orderId, door } = await pickedUpOrder(courier);
        const other = await readyOrder(); // created after: the busy courier is never offered it
        expect((await reportProblem(courier, other.orderId, { category: 'restaurant_closed' })).status).toBe(404);

        await setPosition(courier.id, door);
        await deliver(courier, orderId);
        const res = await reportProblem(courier, orderId, { category: 'wrong_or_missing_items' });
        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({ code: 'ORDER_STATUS_CHANGED', details: { status: 'delivered' } });
    });

    it('the delivery resolves it', async () => {
        const courier = await createCourier();
        const { orderId, door } = await pickedUpOrder(courier);
        await reportProblem(courier, orderId, { category: 'customer_unreachable' });
        await setPosition(courier.id, door);

        await deliver(courier, orderId);

        expect(await openIncidentsOf(orderId)).toEqual([]);
    });

    it('a customer or an owner cannot use it (403)', async () => {
        const courier = await createCourier();
        const { orderId, customer, owner } = await assignedOrder(courier);

        const { api } = await import('../../helpers/http');
        const body = { category: 'other', note: 'x' };
        expect((await api().post(`/courier/orders/${orderId}/problems`).set(customer.headers).send(body)).status).toBe(403);
        expect((await api().post(`/courier/orders/${orderId}/problems`).set(owner).send(body)).status).toBe(403);
    });
});
