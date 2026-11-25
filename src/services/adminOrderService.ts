import type { PoolClient } from 'pg';
import { pool } from '../database/pool';
import { withTransaction } from '../database/transaction';
import { AppError } from '../errors/AppError';
import { getNumberSettings } from './settingsService';
import { lockOrder, assertStatus, assertVersion, ACTIVE_STATUSES, type LockedOrder } from './orderTransition';
import { cancelLockedOrder } from './orderCancellation';
import { resolveOrderIncidents } from './incidents';
import { markPickedUp, markDelivered, getTrip } from './courierOrderService';
import { getRouteOrNull } from './routeService';
import { deliveryEtaSeconds } from '../utils/deliveryEta';
import { dispatchOrderNow, dispatchWaitingOrdersNear } from './dispatchService';
import { CANCEL_REQUEST_COLUMNS, type CancelRequest } from './ownerOrderService';
import type { AdminReasonBody, AdminVersionBody } from '../schemas/adminSchema';

// What the admin can do when an order is stuck (no courier, a courier problem, customer unreachable, cancel
// after pickup). The lists and queues (incidents, cancel requests) come later; here the admin acts on one order, with its version.
//
// Every action: lock the order, check the version the admin saw (409 VERSION_CONFLICT otherwise), check the
// state (409 ORDER_STATUS_CHANGED with status and dispatchState), change it in the same transaction, audit actor
// admin:{id} with the admin's reason in order_status_history. Kicks (dispatch) run after the commit.

type AdminIncident = {
    id: string;
    type: string;
    category: string | null;
    openedBy: string;
    details: string | null;
    openedAt: Date;
    resolvedAt: Date | null;
    resolutionNote: string | null;
};

type AdminOrder = {
    id: string;
    orderCode: string;
    status: string;
    version: number;
    paymentStatus: string;
    dispatchState: string;
    dispatchRound: number;
    dispatchDeadline: Date | null;
    customerId: string;
    restaurant: { id: string; name: string };
    courierId: string | null;
    totalMinor: number;
    currency: string;
    createdAt: Date;
    placedAt: Date | null;
    acceptedAt: Date | null;
    estimatedReadyAt: Date | null;
    readyAt: Date | null;
    pickedUpAt: Date | null;
    estimatedDeliveryAt: Date | null;
    deliveredAt: Date | null;
    endedAt: Date | null;
    cancelledBy: string | null;
    cancelReason: string | null;
    cancelNote: string | null;
    incidents: AdminIncident[];
    cancelRequests: CancelRequest[];
};

function adminActor(adminId: string): string {
    return `admin:${adminId}`;
}

function stateConflict(order: LockedOrder, message: string): AppError {
    return new AppError(409, 'ORDER_STATUS_CHANGED', message, { status: order.status, dispatchState: order.dispatchState });
}

async function getAdminOrder(orderId: string): Promise<AdminOrder> {
    const { rows } = await pool.query<AdminOrder>(
        `SELECT o.id,
                o.order_code AS "orderCode",
                o.status,
                o.version,
                o.payment_status AS "paymentStatus",
                o.dispatch_state AS "dispatchState",
                o.dispatch_round AS "dispatchRound",
                o.dispatch_deadline AS "dispatchDeadline",
                o.customer_id AS "customerId",
                json_build_object('id', r.id::text, 'name', r.name) AS restaurant,
                o.courier_id AS "courierId",
                o.total_minor AS "totalMinor",
                o.currency,
                o.created_at AS "createdAt",
                o.placed_at AS "placedAt",
                o.accepted_at AS "acceptedAt",
                o.estimated_ready_at AS "estimatedReadyAt",
                o.ready_at AS "readyAt",
                o.picked_up_at AS "pickedUpAt",
                o.estimated_delivery_at AS "estimatedDeliveryAt",
                o.delivered_at AS "deliveredAt",
                o.ended_at AS "endedAt",
                o.cancelled_by AS "cancelledBy",
                o.cancel_reason AS "cancelReason",
                o.cancel_note AS "cancelNote",
                COALESCE(
                    (SELECT json_agg(json_build_object(
                                'id', i.id::text, 'type', i.type, 'category', i.category, 'openedBy', i.opened_by,
                                'details', i.details, 'openedAt', i.opened_at, 'resolvedAt', i.resolved_at,
                                'resolutionNote', i.resolution_note) ORDER BY i.id)
                       FROM order_incidents i
                      WHERE i.order_id = o.id),
                    '[]'::json
                ) AS incidents,
                COALESCE(
                    (SELECT json_agg(json_build_object(
                                'id', c.id::text, 'orderId', c.order_id::text, 'status', c.status,
                                'reasonCode', c.reason_code, 'note', c.note, 'version', c.version,
                                'createdAt', c.created_at, 'decidedAt', c.decided_at) ORDER BY c.id)
                       FROM order_cancel_requests c
                      WHERE c.order_id = o.id),
                    '[]'::json
                ) AS "cancelRequests"
           FROM orders o
           JOIN restaurants r ON r.id = o.restaurant_id
          WHERE o.id = $1`,
        [orderId]
    );
    if (!rows[0]) {
        throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }
    return rows[0];
}

// Any non-terminal status → cancelled, by the admin. After pickup only the admin can cancel.
// The hold is voided, so the customer is never charged.
async function adminCancelOrder(adminId: string, orderId: string, body: AdminReasonBody): Promise<AdminOrder> {
    const freedCourierId = await withTransaction(async (client) => {
        const order = await lockOrder(client, orderId, { anyOrder: true });
        assertVersion(order, body.version);
        assertStatus(order, ACTIVE_STATUSES);

        const { freedCourierId } = await cancelLockedOrder(client, order, {
            cancelledBy: 'admin',
            reason: 'admin_cancelled',
            note: body.reason
        });
        return freedCourierId;
    }, adminActor(adminId), `admin cancel: ${body.reason}`);

    if (freedCourierId) {
        await dispatchWaitingOrdersNear(freedCourierId);
    }
    return getAdminOrder(orderId);
}

// The admin marks the pickup for the courier: no location check.
async function adminMarkPickedUp(adminId: string, orderId: string, body: AdminReasonBody): Promise<AdminOrder> {
    // The delivery ETA needs the courier's vehicle and the route. Read before the lock (OSRM is slow); the
    // version check below guarantees the order (and so its courier) did not change since the admin saw it.
    const { rows } = await pool.query<{ courierId: string | null }>(
        `SELECT courier_id AS "courierId" FROM orders WHERE id = $1`,
        [orderId]
    );
    const plannedCourierId = rows[0]?.courierId ?? null;
    const trip = plannedCourierId ? await getTrip(plannedCourierId, orderId) : null;
    const route = trip ? await getRouteOrNull(trip.restaurant, trip.customer) : null;

    await withTransaction(async (client) => {
        const order = await lockOrder(client, orderId, { anyOrder: true });
        assertVersion(order, body.version);
        assertStatus(order, ['accepted', 'ready_for_pickup']);
        if (!order.courierId || !trip || order.courierId !== plannedCourierId) {
            throw stateConflict(order, 'No courier is assigned to this order');
        }

        const etaS = deliveryEtaSeconds(trip.vehicleType, route?.durationS ?? null, trip.roadDistanceM);
        await markPickedUp(client, order.id, etaS, 'picked up (marked by the admin)');
    }, adminActor(adminId), `admin marked picked up: ${body.reason}`);

    return getAdminOrder(orderId);
}

// While the courier reported customer_unreachable less than customer_unreachable_wait_s
// ago, the courier is still waiting at the door: too early to decide.
async function assertCustomerWaitOver(client: PoolClient, orderId: string, waitS: number): Promise<void> {
    const { rows } = await client.query<{ secondsLeft: number }>(
        `SELECT ceil(extract(epoch FROM opened_at + make_interval(secs => $2) - now()))::int AS "secondsLeft"
           FROM order_incidents
          WHERE order_id = $1
            AND type = 'courier_problem'
            AND category = 'customer_unreachable'
            AND resolved_at IS NULL`,
        [orderId, waitS]
    );
    const secondsLeft = rows[0]?.secondsLeft ?? 0;
    if (secondsLeft > 0) {
        throw new AppError(409, 'CUSTOMER_WAIT_NOT_OVER', 'The courier must wait for the customer a little longer', {
            waitS,
            secondsLeft
        });
    }
}

// The admin marks the delivery for the courier. Same as the courier's delivery, including the capture: the food was made and
// brought (the default when the customer is unreachable at the door). The courier is free again.
async function adminMarkDelivered(adminId: string, orderId: string, body: AdminReasonBody): Promise<AdminOrder> {
    const settings = await getNumberSettings(['customer_unreachable_wait_s'] as const);

    const freedCourierId = await withTransaction(async (client) => {
        const order = await lockOrder(client, orderId, { anyOrder: true });
        assertVersion(order, body.version);
        assertStatus(order, ['picked_up']);
        if (!order.paymentIntentId) {
            throw new Error(`Order ${order.id} is picked up but has no PaymentIntent`);
        }
        await assertCustomerWaitOver(client, order.id, settings.customer_unreachable_wait_s);

        await markDelivered(client, order.id, order.paymentIntentId, 'delivered (marked by the admin)');
        return order.courierId;
    }, adminActor(adminId), `admin marked delivered: ${body.reason}`);

    if (freedCourierId) {
        await dispatchWaitingOrdersNear(freedCourierId);
    }
    return getAdminOrder(orderId);
}

// no_courier → searching, a new round with a new deadline. The no_courier incident is resolved; the sweep opens
// a new one if this round fails too.
async function retryDispatch(adminId: string, orderId: string, body: AdminVersionBody): Promise<AdminOrder> {
    const settings = await getNumberSettings(['dispatch_deadline_s'] as const);

    await withTransaction(async (client) => {
        const order = await lockOrder(client, orderId, { anyOrder: true });
        assertVersion(order, body.version);
        assertStatus(order, ['accepted', 'ready_for_pickup']);
        if (order.dispatchState !== 'no_courier') {
            throw stateConflict(order, 'The courier search is not stuck');
        }

        await client.query(
            `UPDATE orders
                SET dispatch_state = 'searching',
                    dispatch_round = dispatch_round + 1,
                    dispatch_deadline = now() + make_interval(secs => $2),
                    next_search_at = now(),
                    version = version + 1
              WHERE id = $1`,
            [order.id, settings.dispatch_deadline_s]
        );
        await resolveOrderIncidents(client, order.id, ['no_courier'], 'the admin started a new courier search', adminId);
    }, adminActor(adminId), 'admin retried dispatch');

    await dispatchOrderNow(orderId);
    return getAdminOrder(orderId);
}

// assigned → searching, the courier is taken off the order before pickup (e.g. a vehicle_issue).
// Their accepted offer becomes withdrawn: they are not asked again for this order, and their pickup gets 409.
// The search gets a fresh deadline (the old one may be long past). A courier_problem is resolved by this.
async function reassignCourier(adminId: string, orderId: string, body: AdminReasonBody): Promise<AdminOrder> {
    const settings = await getNumberSettings(['dispatch_deadline_s'] as const);

    await withTransaction(async (client) => {
        const order = await lockOrder(client, orderId, { anyOrder: true });
        assertVersion(order, body.version);
        assertStatus(order, ['accepted', 'ready_for_pickup']);
        if (order.dispatchState !== 'assigned' || !order.courierId) {
            throw stateConflict(order, 'No courier is assigned to this order');
        }

        await client.query(
            `UPDATE order_offers
                SET status = 'withdrawn'
              WHERE order_id = $1
                AND courier_id = $2
                AND status = 'accepted'`,
            [order.id, order.courierId]
        );
        await client.query(
            `UPDATE orders
                SET courier_id = NULL,
                    dispatch_state = 'searching',
                    dispatch_deadline = now() + make_interval(secs => $2),
                    next_search_at = now(),
                    version = version + 1
              WHERE id = $1`,
            [order.id, settings.dispatch_deadline_s]
        );
        await resolveOrderIncidents(client, order.id, ['courier_problem'], `courier reassigned: ${body.reason}`, adminId);
    }, adminActor(adminId), `admin reassigned the courier: ${body.reason}`);

    await dispatchOrderNow(orderId);
    return getAdminOrder(orderId);
}

// The admin decides an owner's cancel request. The request is found first (no lock), then the order is locked, then the request: the same
// order as the courier's pickup (order → request), which supersedes a pending request.
async function lockCancelRequest(client: PoolClient, requestId: string, seenVersion: number): Promise<{ order: LockedOrder; request: CancelRequest }> {
    const { rows: found } = await client.query<{ orderId: string }>(
        `SELECT order_id AS "orderId" FROM order_cancel_requests WHERE id = $1`,
        [requestId]
    );
    if (!found[0]) {
        throw new AppError(404, 'CANCEL_REQUEST_NOT_FOUND', 'Cancellation request not found');
    }
    const order = await lockOrder(client, found[0].orderId, { anyOrder: true });

    const { rows } = await client.query<CancelRequest>(
        `SELECT ${CANCEL_REQUEST_COLUMNS} FROM order_cancel_requests WHERE id = $1 FOR UPDATE`,
        [requestId]
    );
    const request = rows[0];
    if (request.status !== 'pending') {
        throw new AppError(409, 'CANCEL_REQUEST_CLOSED', 'This request was already decided', {
            requestStatus: request.status,
            status: order.status
        });
    }
    if (request.version !== seenVersion) {
        throw new AppError(409, 'VERSION_CONFLICT', 'The request changed since you loaded it', {
            requestStatus: request.status,
            version: request.version
        });
    }
    return { order, request };
}

async function decideCancelRequest(client: PoolClient, requestId: string, adminId: string, decision: 'approved' | 'rejected'): Promise<void> {
    await client.query(
        `UPDATE order_cancel_requests
            SET status = $2,
                decided_by = $3,
                decided_at = now(),
                version = version + 1
          WHERE id = $1`,
        [requestId, decision, adminId]
    );
}

// Approve → the order is cancelled as by the restaurant (same effects as the owner's direct cancel).
async function approveCancelRequest(adminId: string, requestId: string, body: AdminVersionBody): Promise<AdminOrder> {
    const { orderId, freedCourierId } = await withTransaction(async (client) => {
        const { order, request } = await lockCancelRequest(client, requestId, body.version);
        assertStatus(order, ['ready_for_pickup']);

        // First the request (approved), so the cancel below does not mark it superseded.
        await decideCancelRequest(client, request.id, adminId, 'approved');
        const { freedCourierId } = await cancelLockedOrder(client, order, {
            cancelledBy: 'restaurant',
            reason: request.reasonCode,
            note: request.note
        });
        return { orderId: order.id, freedCourierId };
    }, adminActor(adminId), 'admin approved the restaurant cancellation request');

    if (freedCourierId) {
        await dispatchWaitingOrdersNear(freedCourierId);
    }
    return getAdminOrder(orderId);
}

// Reject → the request is closed, the order goes on unchanged.
async function rejectCancelRequest(adminId: string, requestId: string, body: AdminVersionBody): Promise<AdminOrder> {
    const orderId = await withTransaction(async (client) => {
        const { order, request } = await lockCancelRequest(client, requestId, body.version);
        await decideCancelRequest(client, request.id, adminId, 'rejected');
        return order.id;
    }, adminActor(adminId), 'admin rejected the restaurant cancellation request');

    return getAdminOrder(orderId);
}

export {
    getAdminOrder,
    adminCancelOrder,
    adminMarkPickedUp,
    adminMarkDelivered,
    retryDispatch,
    reassignCourier,
    approveCancelRequest,
    rejectCancelRequest
};
export type { AdminOrder, AdminIncident };
