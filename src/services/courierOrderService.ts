import type { PoolClient } from 'pg';
import { pool } from '../database/pool';
import { withTransaction } from '../database/transaction';
import { AppError } from '../errors/AppError';
import { distanceMeters } from '../utils/geo';
import { deliveryEtaSeconds, type VehicleType } from '../utils/deliveryEta';
import { getNumberSettings } from './settingsService';
import { lockActiveCourier } from './courierService';
import { lockOrder, assertStatus, assertAssignedCourier } from './orderTransition';
import { resolveKitchenLate } from './ownerOrderService';
import { getRouteOrNull } from './routeService';
import type { Point, Route } from './osrmClient';
import { queuePaymentCapture } from './outbox';
import { dispatchWaitingOrdersNear } from './dispatchService';
import { openOrderIncident, resolveOrderIncidents, type ProblemCategory } from './incidents';
import type { ReportProblemBody } from '../schemas/courierSchema';

type CourierOrder = {
    id: string;
    orderCode: string;
    status: 'accepted' | 'ready_for_pickup' | 'picked_up';
    version: number;
    restaurant: { name: string; address: string | null; phone: string | null; lat: number; lng: number };
    customer: {
        firstName: string;
        street: string;
        details: string | null;
        city: string;
        lat: number;
        lng: number;
    };
    items: { name: string; quantity: number }[];
    estimatedReadyAt: Date;
    readyAt: Date | null;
    pickedUpAt: Date | null;
    estimatedDeliveryAt: Date | null;
};

type PickedUpOrder = {
    id: string;
    status: 'picked_up';
    version: number;
    readyAt: Date;
    pickedUpAt: Date;
    estimatedDeliveryAt: Date;
};

const LOCATION_SETTINGS = ['courier_fresh_position_s', 'location_check_radius_m'] as const;
type LocationSettings = Record<(typeof LOCATION_SETTINGS)[number], number>;
type Trip = { restaurant: Point; customer: Point; roadDistanceM: number; vehicleType: VehicleType };
type DeliveredOrder = { id: string; status: 'delivered'; version: number; deliveredAt: Date };

const DELIVERED_COLUMNS = `
    id,
    status,
    version,
    delivered_at AS "deliveredAt"`;

const PICKED_UP_COLUMNS = `
    id,
    status,
    version,
    ready_at AS "readyAt",
    picked_up_at AS "pickedUpAt",
    estimated_delivery_at AS "estimatedDeliveryAt"`;
// The order this courier is delivering now (at most one). The address disappears when it ends.
async function getCurrentOrder(courierId: string): Promise<CourierOrder | null> {
    const { rows } = await pool.query<CourierOrder>(
        `SELECT o.id,
                o.order_code AS "orderCode",
                o.status,
                o.version,
                json_build_object(
                    'name', r.name, 'address', r.address, 'phone', r.phone, 'lat', r.lat, 'lng', r.lng
                ) AS restaurant,
                json_build_object(
                    'firstName', split_part(u.full_name, ' ', 1),
                    'street', o.delivery_address_snapshot->>'street',
                    'details', o.delivery_address_snapshot->>'details',
                    'city', o.delivery_address_snapshot->>'city',
                    'lat', o.delivery_lat,
                    'lng', o.delivery_lng
                ) AS customer,
                COALESCE(
                    (SELECT json_agg(json_build_object('name', oi.name, 'quantity', oi.quantity) ORDER BY oi.id)
                       FROM order_items oi
                      WHERE oi.order_id = o.id),
                    '[]'::json
                ) AS items,
                o.estimated_ready_at AS "estimatedReadyAt",
                o.ready_at AS "readyAt",
                o.picked_up_at AS "pickedUpAt",
                o.estimated_delivery_at AS "estimatedDeliveryAt"
           FROM orders o
           JOIN restaurants r ON r.id = o.restaurant_id
           JOIN users u ON u.id = o.customer_id
          WHERE o.courier_id = $1
            AND o.status IN ('accepted', 'ready_for_pickup', 'picked_up')`,
        [courierId]
    );
    return rows[0] ?? null;
}

async function getRouteToRestaurant(courierId: string, order: CourierOrder): Promise<Route | null> {
    if (order.status === 'picked_up') return null;

    const { rows } = await pool.query<Point>(
        `SELECT lat, lng FROM courier_positions WHERE courier_id = $1`,
        [courierId]
    );
    const position = rows[0];
    if (!position) return null;

    return getRouteOrNull(position, { lat: order.restaurant.lat, lng: order.restaurant.lng });
}

async function assertCourierAt(client: PoolClient, courierId: string, target: Point, settings: LocationSettings): Promise<void> {
    const maxAgeS = settings.courier_fresh_position_s;
    const { rows } = await client.query<Point & { fresh: boolean }>(
        `SELECT lat, lng, received_at > now() - make_interval(secs => $2) AS fresh
           FROM courier_positions
          WHERE courier_id = $1`,
        [courierId, maxAgeS]
    );
    const position = rows[0];
    if (!position?.fresh) {
        throw new AppError(409, 'POSITION_STALE', 'Send your current position first', { maxAgeS });
    }

    const distanceM = distanceMeters(position, target);
    const maxDistanceM = settings.location_check_radius_m;
    if (distanceM > maxDistanceM) {
        throw new AppError(409, 'TOO_FAR_AWAY', 'You are too far away to confirm this', {
            distanceM: Math.round(distanceM),
            maxDistanceM
        });
    }
}

async function getTrip(courierId: string, orderId: string): Promise<Trip | null> {
    const { rows } = await pool.query<Trip>(
        `SELECT json_build_object('lat', r.lat, 'lng', r.lng) AS restaurant,
                json_build_object('lat', o.delivery_lat, 'lng', o.delivery_lng) AS customer,
                o.delivery_distance_m AS "roadDistanceM",
                cp.vehicle_type AS "vehicleType"
           FROM orders o
           JOIN restaurants r ON r.id = o.restaurant_id
           JOIN courier_profiles cp ON cp.user_id = o.courier_id
          WHERE o.id = $1
            AND o.courier_id = $2
            AND o.status IN ('accepted', 'ready_for_pickup', 'picked_up')`,
        [orderId, courierId]
    );
    return rows[0] ?? null;
}

async function pickUpOrder(courierId: string, orderId: string): Promise<PickedUpOrder & { route: Route | null }> {
    const settings = await getNumberSettings(LOCATION_SETTINGS);
    const trip = await getTrip(courierId, orderId);
    // Almost always from the cache: checkout asked for the same two points
    const route = trip ? await getRouteOrNull(trip.restaurant, trip.customer) : null;

    const pickedUp = await withTransaction(async (client) => {
        await lockActiveCourier(client, courierId);
        const order = await lockOrder(client, orderId, { courierId });
        assertAssignedCourier(order, courierId);

        if (order.status === 'picked_up') {
            const { rows } = await client.query<PickedUpOrder>(
                `SELECT ${PICKED_UP_COLUMNS} FROM orders WHERE id = $1`,
                [order.id]
            );
            return rows[0];
        }
        assertStatus(order, ['accepted', 'ready_for_pickup']);
        if (!trip) {
            throw new AppError(409, 'ORDER_STATUS_CHANGED', 'The order changed in the meantime', { status: order.status });
        }
        await assertCourierAt(client, courierId, trip.restaurant, settings);

        const etaS = deliveryEtaSeconds(trip.vehicleType, route?.durationS ?? null, trip.roadDistanceM);
        return markPickedUp(client, order.id, etaS, 'picked up by the courier');
    }, `user:${courierId}`, 'picked up');

    return { ...pickedUp, route };
}

// Pickup by the courier, or by the admin for the courier: the order row and what ends with the pickup.
async function markPickedUp(client: PoolClient, orderId: string, etaS: number, note: string): Promise<PickedUpOrder> {
    const { rows } = await client.query<PickedUpOrder>(
        `UPDATE orders
            SET status = 'picked_up',
                picked_up_at = now(),
                ready_at = COALESCE(ready_at, now()),
                estimated_delivery_at = now() + make_interval(secs => $2),
                version = version + 1
          WHERE id = $1
      RETURNING ${PICKED_UP_COLUMNS}`,
        [orderId, etaS]
    );
    // The food has left: the owner's request to cancel no longer makes sense
    await client.query(
        `UPDATE order_cancel_requests
            SET status = 'superseded',
                decided_at = now(),
                version = version + 1
          WHERE order_id = $1 AND status = 'pending'`,
        [orderId]
    );
    await resolveKitchenLate(client, orderId, note);
    return rows[0];
}

// Delivery by the courier, or by the admin for the courier: delivered, capture queued, every open incident except a capture problem resolved.
async function markDelivered(client: PoolClient, orderId: string, paymentIntentId: string, note: string): Promise<DeliveredOrder> {
    const { rows } = await client.query<DeliveredOrder>(
        `UPDATE orders
            SET status = 'delivered',
                delivered_at = now(),
                ended_at = now(),
                version = version + 1
          WHERE id = $1
      RETURNING ${DELIVERED_COLUMNS}`,
        [orderId]
    );
    await queuePaymentCapture(client, orderId, paymentIntentId);
    await resolveOrderIncidents(client, orderId, ['delivery_overdue', 'courier_problem', 'kitchen_late', 'no_courier'], note);
    return rows[0];
}

async function deliverOrder(courierId: string, orderId: string): Promise<DeliveredOrder> {
    const settings = await getNumberSettings(LOCATION_SETTINGS);

    const { delivered, changed } = await withTransaction(async (client) => {
        await lockActiveCourier(client, courierId);
        const order = await lockOrder(client, orderId, { courierId });
        assertAssignedCourier(order, courierId);

        if (order.status === 'delivered') {
            const { rows } = await client.query<DeliveredOrder>(
                `SELECT ${DELIVERED_COLUMNS} FROM orders WHERE id = $1`,
                [order.id]
            );
            return { delivered: rows[0], changed: false };
        }
        assertStatus(order, ['picked_up']);

        if (!order.paymentIntentId) {
            throw new Error(`Order ${order.id} is picked up but has no PaymentIntent`);
        }

        const { rows: doors } = await client.query<Point>(
            `SELECT delivery_lat AS lat, delivery_lng AS lng FROM orders WHERE id = $1`,
            [order.id]
        );
        await assertCourierAt(client, courierId, doors[0], settings);

        const delivered = await markDelivered(client, order.id, order.paymentIntentId, 'delivered');
        return { delivered, changed: true };
    }, `user:${courierId}`, 'delivered');

    // The courier is free again: waiting orders around them stop sleeping
    if (changed) {
        await dispatchWaitingOrdersNear(courierId);
    }
    return delivered;
}

type ReportedProblem = {
    id: string;
    orderId: string;
    category: ProblemCategory;
    details: string | null;
    openedAt: Date;
};

// "Report a problem": a courier_problem incident for the admin. It never changes the order.
// One open courier_problem per order (unique index): reporting again while one is open returns that one
// (201 new, 200 existing). For customer_unreachable the time it was opened starts the 10 min wait at the door
// (the admin can mark it delivered once it is customer_unreachable_wait_s old).
async function reportProblem(
    courierId: string,
    orderId: string,
    body: ReportProblemBody
): Promise<{ problem: ReportedProblem; created: boolean }> {
    return withTransaction(async (client) => {
        await lockActiveCourier(client, courierId);
        const order = await lockOrder(client, orderId, { courierId });
        assertAssignedCourier(order, courierId);
        assertStatus(order, ['accepted', 'ready_for_pickup', 'picked_up']);

        const newId = await openOrderIncident(client, {
            orderId: order.id,
            type: 'courier_problem',
            category: body.category,
            openedBy: 'courier',
            openedByUserId: courierId,
            details: body.note ?? null
        });

        const { rows } = await client.query<ReportedProblem>(
            `SELECT id,
                    order_id AS "orderId",
                    category,
                    details,
                    opened_at AS "openedAt"
               FROM order_incidents
              WHERE order_id = $1
                AND type = 'courier_problem'
                AND resolved_at IS NULL`,
            [order.id]
        );
        return { problem: rows[0], created: newId !== null };
    }, `user:${courierId}`, `problem reported: ${body.category}`);
}

export { getCurrentOrder, getRouteToRestaurant, pickUpOrder, deliverOrder, reportProblem, markPickedUp, markDelivered, getTrip };
export type { CourierOrder, PickedUpOrder, DeliveredOrder, ReportedProblem };