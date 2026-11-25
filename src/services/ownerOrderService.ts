import type { PoolClient } from 'pg';
import { pool } from '../database/pool';
import { withTransaction } from '../database/transaction';
import { AppError } from '../errors/AppError';
import { getOwnerRestaurant, AUTO_PAUSE_TIMEOUTS } from './restaurantService';
import { getNumberSettings } from './settingsService';
import { lockOrder, assertStatus } from './orderTransition';
import { queuePaymentVoid } from './outbox';
import type { RejectOrderBody, OwnerCancelOrderBody, CancelRequestBody } from '../schemas/ownerOrderSchema';
import { dispatchWaitingOrdersNear } from './dispatchService';
import { restoreCartFromOrder } from './cartService';
import { resolveOrderIncidents } from './incidents';
import { cancelLockedOrder } from './orderCancellation';

type AcceptedOrder = {
    id: string;
    status: string;
    version: number;
    prepMinutes: number;
    acceptedAt: Date;
    estimatedReadyAt: Date;
    dispatchAfter: Date;
};

const ACCEPTED_COLUMNS = `
    id,
    status,
    version,
    prep_minutes AS "prepMinutes",
    accepted_at AS "acceptedAt",
    estimated_ready_at AS "estimatedReadyAt",
    dispatch_after AS "dispatchAfter"`;

type EndedOrder = {
    id: string;
    status: string;
    version: number;
    cancelledBy: string | null;
    cancelReason: string | null;
    cancelNote: string | null;
    endedAt: Date | null;
};

type ReadyOrder = {
    id: string;
    status: string;
    version: number;
    readyAt: Date;
    dispatchAfter: Date;
};

const READY_COLUMNS = `
    id,
    status,
    version,
    ready_at AS "readyAt",
    dispatch_after AS "dispatchAfter"`;

const ENDED_COLUMNS = `
    id,
    status,
    version,
    cancelled_by AS "cancelledBy",
    cancel_reason AS "cancelReason",
    cancel_note AS "cancelNote",
    ended_at AS "endedAt"`;

type CancelRequest = {
    id: string;
    orderId: string;
    status: 'pending' | 'approved' | 'rejected' | 'superseded';
    reasonCode: string;
    note: string | null;
    version: number;
    createdAt: Date;
    decidedAt: Date | null;
};

const CANCEL_REQUEST_COLUMNS = `
    id,
    order_id AS "orderId",
    status,
    reason_code AS "reasonCode",
    note,
    version,
    created_at AS "createdAt",
    decided_at AS "decidedAt"`;

type OwnerOrderItem = { name: string; quantity: number };
type OwnerActiveOrder = {
      id: string;
      orderCode: string;
      status: 'placed' | 'accepted' | 'ready_for_pickup';
      subtotalMinor: number;
      currency: string;
      placedAt: Date;
      acceptDeadline: Date | null;
      prepMinutes: number | null;
      estimatedReadyAt: Date | null;
      readyAt: Date | null;
      items: OwnerOrderItem[];
};
// The owner answered, so the "missed orders in a row" counter starts again
async function resetMissedOrders(client: PoolClient, restaurantId: string): Promise<void>{
    await client.query(
        `UPDATE restaurants
            SET consecutive_timeouts = 0
          WHERE id = $1
            AND consecutive_timeouts > 0
            AND NOT (consecutive_timeouts >= $2 AND paused_until IS NOT NULL AND paused_until > now())`,
        [restaurantId, AUTO_PAUSE_TIMEOUTS]
    );
}
// The kitchen_late incident ends when the food is ready or the order ends.
async function resolveKitchenLate(client: PoolClient, orderId: string, note: string): Promise<void> {
    await resolveOrderIncidents(client, orderId, ['kitchen_late'], note);
}

// placed → accepted, with the prep time the owner promises.
async function acceptOrder(ownerId: string, orderId: string, prepMinutes?: number): Promise<AcceptedOrder>{
    const restaurant = await getOwnerRestaurant(ownerId);
    const settings = await getNumberSettings(['prep_minutes_default', 'dispatch_lead_s'] as const);
    const prep = prepMinutes ?? settings.prep_minutes_default;

    return withTransaction(async (client) => {
        const order = await lockOrder(client, orderId, { restaurantId: restaurant.id });

        // Double click: already accepted, answer with what is stored
        if (order.status === 'accepted') {
            const { rows } = await client.query<AcceptedOrder>(
                `SELECT ${ACCEPTED_COLUMNS} FROM orders WHERE id = $1`,
                [order.id]
            );
            return rows[0];
        }
        assertStatus(order, ['placed']);

        const { rows } = await client.query<AcceptedOrder>(
            `UPDATE orders
                SET status = 'accepted',
                    accepted_at = now(),
                    prep_minutes = $2,
                    estimated_ready_at = now() + make_interval(mins => $2),
                    dispatch_after = greatest(
                        now(),
                        now() + make_interval(mins => $2) - make_interval(secs => $3)
                    ),
                    dispatch_state = 'not_started',
                    version = version + 1
              WHERE id = $1 AND accept_deadline > now()
          RETURNING ${ACCEPTED_COLUMNS}`,
        [order.id, prep, settings.dispatch_lead_s]
        );

        const accepted = rows[0];
        if (!accepted) {
            throw new AppError(409, 'ACCEPT_WINDOW_OVER', 'The time to accept this order is over', { status: order.status });
        }

        await resetMissedOrders(client, restaurant.id);
        return accepted;
    }, `user:${ownerId}`, `accepted, prep ${prep} min`);
}

// The owner ticks the items they ran out of. Only items of THIS order can be ticked
// (an id from somewhere else is ignored). Same transaction as the reject.
async function markOrderItemsUnavailable(
    client: PoolClient,
    restaurantId: string,
    orderId: string,
    ownerId: string,
    menuItemIds: string[]
): Promise<void> {
    if (menuItemIds.length === 0) return;
    await client.query(
        `INSERT INTO restaurant_item_availability (restaurant_id, menu_item_id, available, updated_by)
         SELECT DISTINCT $1::bigint, oi.menu_item_id, false, $3::bigint
           FROM order_items oi
          WHERE oi.order_id = $2
            AND oi.menu_item_id = ANY($4::bigint[])
         ON CONFLICT (restaurant_id, menu_item_id)
         DO UPDATE SET available = false, updated_by = EXCLUDED.updated_by`,
        [restaurantId, orderId, ownerId, menuItemIds]
    );
}

// placed → rejected by the owner. The customer's hold is released by the outbox (void),
// and the items go back into their cart, the ticked ones flagged unavailable there.
async function rejectOrder(ownerId: string, orderId: string, body: RejectOrderBody): Promise<EndedOrder>{
    const restaurant = await getOwnerRestaurant(ownerId);

    return withTransaction(async (client) => {
        const order = await lockOrder(client, orderId, { restaurantId: restaurant.id });

        // Double click: already rejected by this restaurant, answer with what is stored.
        if (order.status === 'rejected' && order.cancelledBy === 'restaurant') {
            const { rows } = await client.query<EndedOrder>(
                `SELECT ${ENDED_COLUMNS} FROM orders WHERE id = $1`,
                [order.id]
            );
            return rows[0];
        }
        assertStatus(order, ['placed']);

        const { rows } = await client.query<EndedOrder>(
            `UPDATE orders
                SET status = 'rejected',
                    cancelled_by = 'restaurant',
                    cancel_reason = $2,
                    cancel_note = $3,
                    ended_at = now(),
                    version = version + 1
              WHERE id = $1
          RETURNING ${ENDED_COLUMNS}`,
          [order.id, body.reasonCode, body.note ?? null]
        );

        if (order.paymentIntentId) {
            await queuePaymentVoid(client, order.id, order.paymentIntentId);
        }
        await markOrderItemsUnavailable(client, restaurant.id, order.id, ownerId, body.unavailableItemIds ?? []);
        await restoreCartFromOrder(client, order.customerId, order.id, order.restaurantId);
        await resetMissedOrders(client, restaurant.id);
        return rows[0];
    }, `user:${ownerId}`, `rejected: ${body.reasonCode}`);
}

// accepted → ready_for_pickup.
async function markOrderReady(ownerId: string, orderId: string): Promise<ReadyOrder> {
    const restaurant = await getOwnerRestaurant(ownerId);

     return withTransaction(async (client) => {
        const order = await lockOrder(client, orderId, { restaurantId: restaurant.id });

        if (order.status === 'ready_for_pickup') {
            const { rows } = await client.query<ReadyOrder>(
                `SELECT ${READY_COLUMNS} FROM orders WHERE id = $1`,
                [order.id]
            );
            return rows[0];
        }
        assertStatus(order, ['accepted']);

        const { rows } = await client.query<ReadyOrder>(
            `UPDATE orders
                SET status = 'ready_for_pickup',
                    ready_at = now(),
                    dispatch_after = least(dispatch_after, now()),
                    version = version + 1
              WHERE id = $1
            RETURNING ${READY_COLUMNS}`,
            [order.id]
        );

        await resolveKitchenLate(client, order.id, 'marked ready by the restaurant');
        return rows[0];
     }, `user:${ownerId}`, 'marked ready');
}

// accepted → cancelled by the owner. Once the food is ready the owner can only ask (requestOrderCancellation).
async function ownerCancelOrder(ownerId: string, orderId: string, body: OwnerCancelOrderBody): Promise<EndedOrder> {
    const restaurant = await getOwnerRestaurant(ownerId);

     const { cancelled, freedCourierId } = await withTransaction(async (client) => {
        const order = await lockOrder(client, orderId, { restaurantId: restaurant.id });

        if (order.status === 'cancelled' && order.cancelledBy === 'restaurant') {
            const { rows } = await client.query<EndedOrder>(
                `SELECT ${ENDED_COLUMNS} FROM orders WHERE id = $1`,
                [order.id]
            );
            return { cancelled: rows[0], freedCourierId: null };
        }
        assertStatus(order, ['accepted']);

        // Withdraws a pending offer, releases the courier, voids, resolves kitchen_late / no_courier / courier_problem
        const { freedCourierId } = await cancelLockedOrder(client, order, {
            cancelledBy: 'restaurant',
            reason: body.reasonCode,
            note: body.note
        });
        const { rows } = await client.query<EndedOrder>(`SELECT ${ENDED_COLUMNS} FROM orders WHERE id = $1`, [order.id]);
        return { cancelled: rows[0], freedCourierId };
     },`user:${ownerId}`, `cancelled by the restaurant: ${body.reasonCode}`);

     if (freedCourierId) {
        await dispatchWaitingOrdersNear(freedCourierId);
     }
    return cancelled;
}

// The food is ready, so the owner can no longer cancel alone; they ask the admin.
// One pending request per order (order_cancel_requests_one_pending_uq). Asking again while one is pending
// returns that one (double click). 201 for a new request, 200 for the existing one.
async function requestOrderCancellation(
    ownerId: string,
    orderId: string,
    body: CancelRequestBody
): Promise<{ request: CancelRequest; created: boolean }> {
    const restaurant = await getOwnerRestaurant(ownerId);

    return withTransaction(async (client) => {
        const order = await lockOrder(client, orderId, { restaurantId: restaurant.id });

        const pending = await client.query<CancelRequest>(
            `SELECT ${CANCEL_REQUEST_COLUMNS} FROM order_cancel_requests WHERE order_id = $1 AND status = 'pending'`,
            [order.id]
        );
        if (pending.rows[0]) {
            return { request: pending.rows[0], created: false };
        }
        // accepted: cancel directly (ownerCancelOrder). picked_up and later: only the admin.
        assertStatus(order, ['ready_for_pickup']);

        const { rows } = await client.query<CancelRequest>(
            `INSERT INTO order_cancel_requests (order_id, requested_by, reason_code, note)
             VALUES ($1, $2, $3, $4)
             RETURNING ${CANCEL_REQUEST_COLUMNS}`,
            [order.id, ownerId, body.reasonCode, body.note ?? null]
        );
        return { request: rows[0], created: true };
    }, `user:${ownerId}`, `cancellation requested: ${body.reasonCode}`);
}

// The kitchen board: orders the restaurant still has to answer, cook or hand over.
// Most urgent first.
async function listOwnerActiveOrders(ownerId: string): Promise<OwnerActiveOrder[]> {
    const restaurant = await getOwnerRestaurant(ownerId);
    const { rows } = await pool.query<OwnerActiveOrder>(
        `SELECT o.id,
                  o.order_code AS "orderCode",
                  o.status,
                  o.subtotal_minor AS "subtotalMinor",
                  o.currency,
                  o.placed_at AS "placedAt",
                  o.accept_deadline AS "acceptDeadline",
                  o.prep_minutes AS "prepMinutes",
                  o.estimated_ready_at AS "estimatedReadyAt",
                  o.ready_at AS "readyAt",
                  COALESCE(
                      (SELECT json_agg(json_build_object('name', oi.name, 'quantity', oi.quantity)
                            ORDER BY oi.id)
                        FROM order_items oi
                        WHERE oi.order_id = o.id),
                      '[]'::json
                    ) AS items
             FROM orders o
            WHERE o.restaurant_id = $1
              AND o.status IN ('placed', 'accepted', 'ready_for_pickup')
              AND NOT (o.status = 'placed' AND o.accept_deadline <= now())
            ORDER BY CASE o.status WHEN 'placed' THEN 0 WHEN 'accepted' THEN 1 ELSE 2 END,
                     CASE o.status
                         WHEN 'placed' THEN o.accept_deadline
                         WHEN 'accepted' THEN o.estimated_ready_at
                         ELSE o.ready_at
                     END,
                     o.id`,
        [restaurant.id]
    );
    return rows;
}

export {
    acceptOrder,
    rejectOrder,
    markOrderReady,
    ownerCancelOrder,
    requestOrderCancellation,
    resetMissedOrders,
    resolveKitchenLate,
    listOwnerActiveOrders,
    CANCEL_REQUEST_COLUMNS
}
export type { AcceptedOrder, EndedOrder, ReadyOrder, OwnerActiveOrder, CancelRequest };
