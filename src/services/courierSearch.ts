import type { PoolClient } from 'pg';
import type { RobotVehicle } from '../utils/deliveryEta';

type SearchInput = {
    orderId: string;
    round: number;
    restaurantLat: number;
    restaurantLng: number;
    freshPositionS: number;
    // M9b: null = a human order, only human couriers. Otherwise a robot order, only robots of THIS vehicle
    // (the one its fee was quoted for: a sidewalk robot never gets a 5 km route).
    robotVehicle: RobotVehicle | null;
};
type CourierCandidate = { courierId: string; distanceM: number };

const SEARCH_RADIUS_M = 10_000;
const MAX_CANDIDATES = 5;
// A little under the real 111,195 m, so the box is never smaller than the circle
export const BOX_M_PER_DEGREE = 111_000;

async function findCourierCandidates(client: PoolClient, search: SearchInput): Promise<CourierCandidate[]> {
    const { orderId, round, restaurantLat: lat, restaurantLng: lng, freshPositionS, robotVehicle } = search;
    const latDelta = SEARCH_RADIUS_M / BOX_M_PER_DEGREE;
    const lngDelta = latDelta / Math.cos((lat * Math.PI) / 180);

    const { rows } = await client.query<CourierCandidate>(
        `SELECT c.courier_id AS "courierId",
                round(c.distance)::int AS "distanceM"
           FROM (
                SELECT p.courier_id,
                       cp.went_online_at,
                       2 * 6371000 * asin(sqrt(
                           power(sin(radians(p.lat - $1::float8) / 2), 2) +
                           cos(radians($1::float8)) * cos(radians(p.lat)) *
                           power(sin(radians(p.lng - $2::float8) / 2), 2)
                       )) AS distance
                  FROM courier_positions p
                  JOIN courier_profiles cp ON cp.user_id = p.courier_id
                  JOIN users u ON u.id = p.courier_id
                 WHERE p.lat BETWEEN $3::float8 AND $4::float8
                   AND p.lng BETWEEN $5::float8 AND $6::float8
                   AND p.received_at > now() - make_interval(secs => $7)
                   AND cp.availability = 'online'
                   AND u.status = 'active'
                   -- the split: humans for human orders, the right robot vehicle for robot orders
                   AND CASE WHEN $12::vehicle_type IS NULL THEN NOT cp.is_robot
                            ELSE cp.vehicle_type = $12::vehicle_type
                       END
                   AND NOT EXISTS (
                       SELECT 1 FROM orders o
                        WHERE o.courier_id = p.courier_id
                          AND o.status IN ('accepted', 'ready_for_pickup', 'picked_up'))
                   AND NOT EXISTS (
                       SELECT 1 FROM order_offers f
                        WHERE f.courier_id = p.courier_id
                          AND f.status = 'pending')
                   -- not asked this round; and in any later round a courier who let this order's offer
                   -- expire, or was taken off it by the admin (withdrawn), is not asked again: only decliners are
                   AND NOT EXISTS (
                       SELECT 1 FROM order_offers f
                        WHERE f.order_id = $8
                          AND (f.round = $9 OR f.status IN ('expired', 'withdrawn'))
                          AND f.courier_id = p.courier_id)
                ) c
          WHERE c.distance <= $10
          ORDER BY c.distance, c.went_online_at, c.courier_id
          LIMIT $11`,
          [lat, lng,
            lat - latDelta, lat + latDelta,
            lng - lngDelta, lng + lngDelta,
            freshPositionS,
            orderId, round,
            SEARCH_RADIUS_M, MAX_CANDIDATES,
            robotVehicle
          ]
    );
    return rows;
}

// Checkout guard (human orders only): is there any online, active HUMAN courier with a fresh position within SEARCH_RADIUS_M
// of the restaurant? Busy couriers count too: they may be free by the time the food is ready.
async function hasCourierNear(client: PoolClient, lat: number, lng: number, freshPositionS: number): Promise<boolean> {
    const latDelta = SEARCH_RADIUS_M / BOX_M_PER_DEGREE;
    const lngDelta = latDelta / Math.cos((lat * Math.PI) / 180);

    const { rows } = await client.query<{ found: boolean }>(
        `SELECT EXISTS (
             SELECT 1
               FROM courier_positions p
               JOIN courier_profiles cp ON cp.user_id = p.courier_id
               JOIN users u ON u.id = p.courier_id
              WHERE p.lat BETWEEN $3::float8 AND $4::float8
                AND p.lng BETWEEN $5::float8 AND $6::float8
                AND p.received_at > now() - make_interval(secs => $7)
                AND cp.availability = 'online'
                AND u.status = 'active'
                AND NOT cp.is_robot   -- robots never count for a human checkout (T1)
                AND 2 * 6371000 * asin(sqrt(
                        power(sin(radians(p.lat - $1::float8) / 2), 2) +
                        cos(radians($1::float8)) * cos(radians(p.lat)) *
                        power(sin(radians(p.lng - $2::float8) / 2), 2)
                    )) <= $8
         ) AS found`,
        [lat, lng, lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta, freshPositionS, SEARCH_RADIUS_M]
    );
    return rows[0].found;
}

export { findCourierCandidates, hasCourierNear, SEARCH_RADIUS_M };
export type { CourierCandidate, SearchInput };