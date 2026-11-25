import { pool } from '../database/pool';
import { withTransaction } from '../database/transaction';
import { logger } from '../logger';
import { getNumberSettings } from './settingsService';
import { findCourierCandidates } from './courierSearch';
import { dispatchOrderNow } from './dispatchService';
import { robotVehicleFor, type RobotVehicle } from '../utils/deliveryEta';

// M9b robot couriers (decisions A, E, F in the M9b notes). The worker DECIDES here which robot works:
// it puts the robot online with a position at the restaurant, and the normal dispatch offers it the order.
// The robot runner (scripts/robotRunner.ts) only drives robots that are already online.

const MAX_ORDERS_PER_PASS = 20;
const MAX_ROBOTS_PER_PASS = 50;

// A robot order that needs a robot: being searched, nobody assigned, no open offer. Also not while the
// same customer already has a robot on another order (rule E: one robot per customer; it waits).
// $1 is the order id, or NULL for the list.
const NEEDS_ROBOT = `
    o.delivery_mode = 'robot'
    AND o.status IN ('accepted', 'ready_for_pickup')
    AND o.dispatch_state IN ('searching', 'no_courier')
    AND o.courier_id IS NULL
    AND ($1::bigint IS NULL OR o.id = $1)
    AND NOT EXISTS (
        SELECT 1 FROM order_offers f
         WHERE f.order_id = o.id AND f.status = 'pending')
    AND NOT EXISTS (
        SELECT 1 FROM orders o2
         WHERE o2.customer_id = o.customer_id
           AND o2.id <> o.id
           AND o2.delivery_mode = 'robot'
           AND o2.courier_id IS NOT NULL
           AND o2.status IN ('accepted', 'ready_for_pickup', 'picked_up'))`;

type RobotOrder = {
    id: string;
    round: number;
    restaurantLat: number;
    restaurantLng: number;
    deliveryDistanceM: number;
};

type StartSettings = { courier_fresh_position_s: number; robot_max_distance_m: number };

// One order, one transaction. Returns the started robot's id, or null when none was needed or none is free.
async function startRobotFor(orderId: string, settings: StartSettings): Promise<{ robotId: string; vehicle: RobotVehicle } | null> {
    return withTransaction(async (client) => {
        // Locked and checked again: another worker, the dispatch or a cancel may have changed it since the list
        const { rows } = await client.query<RobotOrder>(
            `SELECT o.id,
                    o.dispatch_round AS round,
                    r.lat AS "restaurantLat",
                    r.lng AS "restaurantLng",
                    o.delivery_distance_m AS "deliveryDistanceM"
               FROM orders o
               JOIN restaurants r ON r.id = o.restaurant_id
              WHERE ${NEEDS_ROBOT}
              FOR UPDATE OF o SKIP LOCKED`,
            [orderId]
        );
        const order = rows[0];
        if (!order) return null;

        const vehicle = robotVehicleFor(order.deliveryDistanceM, settings.robot_max_distance_m);

        // A robot of the right vehicle is already online and free near the restaurant (started for an order
        // that was then cancelled, or a second order at the same restaurant): the dispatch offers it, no new one.
        // The same query the dispatch uses, so "would be offered" and "do not start one" never disagree.
        const waiting = await findCourierCandidates(client, {
            orderId: order.id,
            round: order.round,
            restaurantLat: order.restaurantLat,
            restaurantLng: order.restaurantLng,
            freshPositionS: settings.courier_fresh_position_s,
            robotVehicle: vehicle,
        });
        if (waiting.length > 0) return null;

        // A free robot of that vehicle: offline, active, no delivery, and never one whose offer for THIS order
        // expired or was withdrawn (the search would skip it, and we would start robots forever).
        // The least recently started first, so the fleet takes turns. SKIP LOCKED on the users row, like every
        // other courier lock: a robot being changed right now is simply not picked.
        const robot = await client.query<{ id: string }>(
            `SELECT cp.user_id AS id
               FROM courier_profiles cp
               JOIN users u ON u.id = cp.user_id
              WHERE cp.is_robot
                AND cp.vehicle_type = $1::vehicle_type
                AND cp.availability = 'offline'
                AND u.status = 'active'
                AND NOT EXISTS (
                    SELECT 1 FROM orders o
                     WHERE o.courier_id = cp.user_id
                       AND o.status IN ('accepted', 'ready_for_pickup', 'picked_up'))
                AND NOT EXISTS (
                    SELECT 1 FROM order_offers f
                     WHERE f.order_id = $2
                       AND f.courier_id = cp.user_id
                       AND f.status IN ('expired', 'withdrawn'))
              ORDER BY cp.went_online_at NULLS FIRST, cp.user_id
              LIMIT 1
              FOR NO KEY UPDATE OF u SKIP LOCKED`,
            [vehicle, order.id]
        );
        const robotId = robot.rows[0]?.id;
        if (!robotId) {
            // The fleet is busy: the order keeps searching and, past its deadline, goes no_courier like any order
            return null;
        }

        // The robot appears at the restaurant with a fresh position, then goes online (the same columns as goOnline)
        await client.query(
            `INSERT INTO courier_positions (courier_id, lat, lng, recorded_at, received_at)
             VALUES ($1, $2::float8, $3::float8, now(), now())
             ON CONFLICT (courier_id) DO UPDATE SET
                lat = EXCLUDED.lat,
                lng = EXCLUDED.lng,
                accuracy_m = NULL,
                heading_deg = NULL,
                speed_mps = NULL,
                recorded_at = EXCLUDED.recorded_at,
                received_at = EXCLUDED.received_at`,
            [robotId, order.restaurantLat, order.restaurantLng]
        );
        await client.query(
            `UPDATE courier_profiles
                SET availability = 'online',
                    offline_reason = NULL,
                    went_online_at = now(),
                    consecutive_missed_offers = 0
              WHERE user_id = $1`,
            [robotId]
        );
        // Search this order at once (it may be sleeping in the 2/5/10/30 s backoff)
        await client.query(`UPDATE orders SET next_search_at = now() WHERE id = $1`, [order.id]);

        return { robotId, vehicle };
    }, 'system:robot-start', 'robot started for a robot order');
}

// Called by the worker every 2 s. Returns how many robots it started.
async function startRobotsForDueOrders(): Promise<number> {
    const settings = await getNumberSettings(['courier_fresh_position_s', 'robot_max_distance_m'] as const);

    // No lock: only the list. Each order is locked and checked again in startRobotFor.
    const { rows } = await pool.query<{ id: string }>(
        `SELECT o.id
           FROM orders o
          WHERE ${NEEDS_ROBOT}
          ORDER BY o.dispatch_started_at, o.id
          LIMIT $2`,
        [null, MAX_ORDERS_PER_PASS]
    );

    let started = 0;
    for (const { id } of rows) {
        const result = await startRobotFor(id, settings);
        if (!result) continue;
        started++;
        logger.info({ orderId: id, courierId: result.robotId, vehicle: result.vehicle }, 'Robot started for an order');
        // After the COMMIT: offer it now instead of at the next 2 s tick (never throws)
        await dispatchOrderNow(id);
    }
    return started;
}

// An online robot with nothing to do: no delivery, no open offer, and no offer for robot_idle_offline_s.
// $1 = robot_idle_offline_s. (After a delivery the runner sets its robot offline itself; this catches the
// robots whose order was cancelled before pickup, and those of a runner that died.)
const IDLE_ROBOT = `
    cp.is_robot
    AND cp.availability = 'online'
    AND cp.went_online_at <= now() - make_interval(secs => $1)
    AND NOT EXISTS (
        SELECT 1 FROM orders o
         WHERE o.courier_id = cp.user_id
           AND o.status IN ('accepted', 'ready_for_pickup', 'picked_up'))
    AND NOT EXISTS (
        SELECT 1 FROM order_offers f
         WHERE f.courier_id = cp.user_id
           AND (f.status = 'pending' OR f.offered_at > now() - make_interval(secs => $1)))`;

async function setOfflineIfStillIdle(robotId: string, idleS: number): Promise<boolean> {
    return withTransaction(async (client) => {
        const { rows } = await client.query(
            `SELECT 1 FROM users WHERE id = $1 FOR NO KEY UPDATE SKIP LOCKED`,
            [robotId]
        );
        if (!rows[0]) return false;

        // The same rule again, under the lock: an offer that arrived in between keeps it online
        const result = await client.query(
            `UPDATE courier_profiles cp
                SET availability = 'offline',
                    offline_reason = 'manual'
              WHERE cp.user_id = $2
                AND ${IDLE_ROBOT}`,
            [idleS, robotId]
        );
        return result.rowCount === 1;
    }, 'system:robot-idle', 'robot idle');
}

// Called by the worker every 30 s. Returns how many robots it set offline.
async function setIdleRobotsOffline(): Promise<number> {
    const { robot_idle_offline_s: idleS } = await getNumberSettings(['robot_idle_offline_s'] as const);

    const { rows } = await pool.query<{ id: string }>(
        `SELECT cp.user_id AS id
           FROM courier_profiles cp
          WHERE ${IDLE_ROBOT}
          LIMIT $2`,
        [idleS, MAX_ROBOTS_PER_PASS]
    );

    let count = 0;
    for (const { id } of rows) {
        if (await setOfflineIfStillIdle(id, idleS)) {
            count++;
            logger.info({ courierId: id }, 'Idle robot set offline');
        }
    }
    return count;
}

export { startRobotsForDueOrders, setIdleRobotsOffline };
