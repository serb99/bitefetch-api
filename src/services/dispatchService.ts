import { pool } from '../database/pool';
import { PoolClient } from 'pg';
import { withTransaction } from '../database/transaction';
import { logger } from '../logger';
import { getNumberSettings } from './settingsService';
import { findCourierCandidates, SEARCH_RADIUS_M, BOX_M_PER_DEGREE, type CourierCandidate } from './courierSearch';
import { openOrderIncident } from './incidents';
import { robotVehicleFor, type RobotVehicle } from '../utils/deliveryEta';
import type { DeliveryMode } from '../schemas/checkoutSchema';

const MAX_ORDERS_PER_PASS = 50;
const MAX_ORDERS_PER_KICK = 5;

const SETTING_KEYS = [
    'dispatch_deadline_s', 'offer_timeout_s', 'courier_fresh_position_s', 'second_round_after_s', 'robot_max_distance_m',
] as const;
type DispatchSettings = Record<(typeof SETTING_KEYS)[number], number>;

type DispatchOrder = {
    id: string;
    round: number;
    restaurantLat: number;
    restaurantLng: number;
    deliveryMode: DeliveryMode;     // M9b: who may get it
    deliveryDistanceM: number;      // M9b: picks the robot vehicle (sidewalk or car)
};

// The order's columns every claim reads (both claims return the same shape)
const ORDER_COLUMNS = `
    o.id,
    r.lat AS "restaurantLat",
    r.lng AS "restaurantLng",
    o.delivery_mode AS "deliveryMode",
    o.delivery_distance_m AS "deliveryDistanceM"`;

// M9b: null for a human order (humans only). For a robot order the same rule as the checkout quote,
// so the robot that comes is the one whose price the customer paid.
function robotVehicleOf(order: DispatchOrder, settings: DispatchSettings): RobotVehicle | null {
    return order.deliveryMode === 'robot' ? robotVehicleFor(order.deliveryDistanceM, settings.robot_max_distance_m) : null;
}
type DispatchResult = { orderId: string; offeredTo: CourierCandidate | null };

// the next order whose dispatch time has come, locked and moved to searching
async function claimOrderToStart(client: PoolClient, deadlineS: number): Promise<DispatchOrder | null> {
    const { rows } = await client.query<Omit<DispatchOrder, 'round'>>(
        `SELECT ${ORDER_COLUMNS}
           FROM orders o
           JOIN restaurants r ON r.id = o.restaurant_id
          WHERE o.status IN ('accepted', 'ready_for_pickup')
            AND o.dispatch_state = 'not_started'
            AND o.dispatch_after <= now()
          ORDER BY o.dispatch_after, o.id
          LIMIT 1
          FOR UPDATE OF o SKIP LOCKED`
    );
    const order = rows[0];
    if (!order) return null;

    await client.query(
        `UPDATE orders
            SET dispatch_state = 'searching',
                dispatch_round = 1,
                dispatch_started_at = now(),
                dispatch_deadline = now() + make_interval(secs => $2),
                version = version + 1
          WHERE id = $1`,
        [order.id, deadlineS]
    );
    return { ...order, round: 1};
}

// the next searching order that is due and has no open offer, locked.
async function claimOrderToSearch(client: PoolClient, orderId: string | null):  Promise<DispatchOrder | null> {
    const { rows } = await client.query<DispatchOrder>(
        `SELECT ${ORDER_COLUMNS},
                o.dispatch_round AS round
           FROM orders o
           JOIN restaurants r ON r.id = o.restaurant_id
          WHERE o.status IN ('accepted', 'ready_for_pickup')
            AND o.dispatch_state IN ('searching', 'no_courier')
            AND o.next_search_at <= now()
            AND ($1::bigint IS NULL OR o.id = $1)
            AND NOT EXISTS (
                SELECT 1 FROM order_offers f
                 WHERE f.order_id = o.id AND f.status = 'pending')
          ORDER BY o.next_search_at, o.id
          LIMIT 1
          FOR UPDATE OF o SKIP LOCKED`,
        [orderId]
    );
    return rows[0] ?? null;
}

// The candidate list can be old by now: lock this courier, check again, then offer.
// False: take the next candidate.
async function tryOffer(client: PoolClient, order: DispatchOrder, candidate: CourierCandidate, timeoutS: number): Promise<boolean> {
    // Nothing back: went offline, or someone is changing this courier right now.
    const locked = await client.query(
        `SELECT 1 FROM courier_profiles
          WHERE user_id = $1 AND availability = 'online'
          FOR NO KEY UPDATE SKIP LOCKED`,
          [candidate.courierId]
    );
    if (locked.rowCount === 0) return false;

    //what was committed before we got the lock
     const { rows } = await client.query<{ free: boolean }>(
        `SELECT NOT EXISTS (
                    SELECT 1 FROM order_offers
                     WHERE courier_id = $1 AND status = 'pending')
            AND NOT EXISTS (
                    SELECT 1 FROM orders
                     WHERE courier_id = $1 AND status IN ('accepted', 'ready_for_pickup', 'picked_up'))
             AS free`,
        [candidate.courierId]
    );
    if (!rows[0].free) return false;

    const offer = await client.query(
        `INSERT INTO order_offers (order_id, courier_id, round, distance_m, expires_at)
         VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))
         ON CONFLICT DO NOTHING`,
        [order.id, candidate.courierId, order.round, candidate.distanceM, timeoutS]
    );
    return offer.rowCount === 1;
}

// The automatic second round: only from round 1, only while searching (not no_courier), only after second_round_after_s.
// Conditional on dispatch_round = 1, so it runs at most once. dispatch_deadline is NOT moved: no_courier still
// comes at the original deadline. No version bump: the order's state does not change.
async function startSecondRound(client: PoolClient, orderId: string, afterS: number): Promise<boolean> {
    const result = await client.query(
        `UPDATE orders
            SET dispatch_round = 2
          WHERE id = $1
            AND dispatch_round = 1
            AND dispatch_state = 'searching'
            AND dispatch_started_at <= now() - make_interval(secs => $2)`,
        [orderId, afterS]
    );
    return result.rowCount === 1;
}

async function searchAndOffer(client: PoolClient, order: DispatchOrder, settings: DispatchSettings): Promise<DispatchResult> {
    const candidates = await findCourierCandidates(client, {
        orderId: order.id,
        round: order.round,
        restaurantLat: order.restaurantLat,
        restaurantLng: order.restaurantLng,
        freshPositionS: settings.courier_fresh_position_s,
        robotVehicle: robotVehicleOf(order, settings),
    });

    for (const candidate of candidates) {
        if (await tryOffer(client, order, candidate, settings.offer_timeout_s)){
            await client.query(
                `UPDATE orders
                    SET next_search_at = now() + make_interval(secs => $2)
                  WHERE id = $1`,
                [order.id, settings.offer_timeout_s]
            );
            return { orderId: order.id, offeredTo: candidate };
        }
    }

    // Nobody left in round 1 and the search runs for a while → one automatic second round that
    // re-asks the couriers who declined (the search query skips those who let it expire). Search again at once.
    if (candidates.length === 0 && order.round === 1 && (await startSecondRound(client, order.id, settings.second_round_after_s))) {
        logger.info({ orderId: order.id }, 'Dispatch: second round, asking the decliners again');
        return searchAndOffer(client, { ...order, round: 2 }, settings);
    }

     // Nobody: the longer the search runs, the less often we look (2 → 5 → 10 → 30 s)
     await client.query(
        `UPDATE orders
            SET next_search_at = now() + CASE
                    WHEN now() - dispatch_started_at < interval '10 seconds' THEN interval '2 seconds'
                    WHEN now() - dispatch_started_at < interval '30 seconds' THEN interval '5 seconds'
                    WHEN now() - dispatch_started_at < interval '1 minute'   THEN interval '10 seconds'
                    ELSE interval '30 seconds'
                END
          WHERE id = $1`,
        [order.id]
    );
    return { orderId: order.id, offeredTo: null };
}

async function dispatchOne(
    settings: DispatchSettings,
    claim: (client: PoolClient) => Promise<DispatchOrder | null>
): Promise<DispatchResult | null> {
    const result = await withTransaction(async (client) => {
        const order = await claim(client);
        return order ? searchAndOffer(client, order, settings) : null;
    }, 'system:dispatch', 'courier search');

    if (result?.offeredTo) {
        logger.info({ orderId: result.orderId, ...result.offeredTo }, 'Order offered to a courier');
    }
    return result;
}

// Called by the 2 s timer. Returns how many orders it handled.
async function dispatchDueOrders(): Promise<number> {
    const settings = await getNumberSettings(SETTING_KEYS);

    let started = 0;
    while (
        started < MAX_ORDERS_PER_PASS &&
        (await dispatchOne(settings, (client) => claimOrderToStart(client, settings.dispatch_deadline_s)))
    ) {
        started++;
    }

    let searched = 0;
    while (searched < MAX_ORDERS_PER_PASS && (await dispatchOne(settings, (client) => claimOrderToSearch(client, null)))) {
        searched++;
    }
    return started + searched;
}

// One order searching past dispatch_deadline with nobody assigned → no_courier + one incident.
// The search goes on in no_courier (claimOrderToSearch takes both), and a pending offer stays valid:
// the courier's accept works in either state. Returns false when no order is due.
async function markNextNoCourierOrder(): Promise<boolean> {
    return withTransaction(async (client) => {
        const { rows } = await client.query<{ id: string }>(
            `SELECT id
               FROM orders
              WHERE status IN ('accepted', 'ready_for_pickup')
                AND dispatch_state = 'searching'
                AND courier_id IS NULL
                AND dispatch_deadline <= now()
              ORDER BY dispatch_deadline, id
              LIMIT 1
              FOR UPDATE SKIP LOCKED`
        );
        const order = rows[0];
        if (!order) return false;

        await client.query(
            `UPDATE orders
                SET dispatch_state = 'no_courier',
                    version = version + 1
              WHERE id = $1`,
            [order.id]
        );
        await openOrderIncident(client, {
            orderId: order.id,
            type: 'no_courier',
            openedBy: 'system',
            details: 'Nobody accepted before the dispatch deadline'
        });
        logger.warn({ orderId: order.id }, 'No courier found before the deadline, incident opened');
        return true;
    }, 'system:dispatch', 'no courier found before the deadline');
}

// The no_courier sweep, run by the dispatch job. Returns how many orders it moved to no_courier.
async function markNoCourierOrders(): Promise<number> {
    let count = 0;
    while (count < MAX_ORDERS_PER_PASS && (await markNextNoCourierOrder())) {
        count++;
    }
    return count;
}

// The kick, called after a COMMIT. If it fails, the timer does the same job 2 s later.
async function dispatchOrderNow(orderId: string): Promise<void> {
    try {
        const settings = await getNumberSettings(SETTING_KEYS);
        await dispatchOne(settings, (client) => claimOrderToSearch(client, orderId));
    } catch (err) {
        logger.error({ err, orderId }, 'Dispatch kick failed, the timer will retry');
    }
}

// The kick when a courier becomes available: the oldest waiting orders around them stop sleeping.
// M9b: only orders of the courier's kind (a free robot never wakes human orders, and the reverse).
// The vehicle is not matched here: a robot of the wrong vehicle only causes a search that finds nobody.
async function dispatchWaitingOrdersNear(courierId: string): Promise<void> {
    try {
        const { rows } = await pool.query<{ id: string }>(
            `WITH waiting AS (
                 SELECT o.id
                   FROM orders o
                   JOIN restaurants r ON r.id = o.restaurant_id
                   JOIN courier_positions p ON p.courier_id = $1
                   JOIN courier_profiles cp ON cp.user_id = $1
                  WHERE o.status IN ('accepted', 'ready_for_pickup')
                    AND o.dispatch_state IN ('searching', 'no_courier')
                    AND o.delivery_mode = CASE WHEN cp.is_robot THEN 'robot'::delivery_mode ELSE 'human'::delivery_mode END
                    AND abs(r.lat - p.lat) <= $2::float8
                    AND abs(r.lng - p.lng) <= $2::float8 / cos(radians(r.lat))
                    AND NOT EXISTS (
                        SELECT 1 FROM order_offers f
                         WHERE f.order_id = o.id
                           AND (f.status = 'pending'
                                OR (f.courier_id = $1
                                    AND (f.round = o.dispatch_round OR f.status IN ('expired', 'withdrawn')))))
                  ORDER BY o.dispatch_started_at, o.id
                  LIMIT $3
                  FOR UPDATE OF o SKIP LOCKED
             ), woken AS (
                 UPDATE orders o
                    SET next_search_at = now()
                   FROM waiting
                  WHERE o.id = waiting.id
              RETURNING o.id, o.dispatch_started_at
             )
             SELECT id FROM woken ORDER BY dispatch_started_at, id`,
            [courierId, SEARCH_RADIUS_M / BOX_M_PER_DEGREE, MAX_ORDERS_PER_KICK]
        );
        // One at a time, oldest first, so the longest waiting order gets the courier
        for (const order of rows) {
            await dispatchOrderNow(order.id);
        }
    } catch(err) {
        logger.error({ err, courierId }, 'Waking waiting orders failed, the timer will find them');
    }
}

export { dispatchDueOrders, dispatchOrderNow, dispatchWaitingOrdersNear, markNoCourierOrders };