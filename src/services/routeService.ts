import { pool } from '../database/pool';
import { fetchRoute, type Point, type Route } from './osrmClient';

const CACHE_TTL_DAYS = 7;

// routes being fetched right now, by cache key, so identical requests share one call
const inFlight = new Map<string, Promise<Route>>();

// Rounds a coordinate (latitude or longitude) to 4 decimal places.
// this value goes into the route cache key, and coordinates that are only a few
// metres apart should share ONE cached route instead of each asking OSRM again.
function round4(n: number): number {
    return Number(n.toFixed(4));
}

function roundPoint(p: Point): Point {
    return { lat: round4(p.lat), lng: round4(p.lng) };
}

async function loadRoute(key: string, from: Point, to: Point): Promise<Route> {
    const cached = await pool.query<Route> (
        `SELECT distance_m AS "distanceM", duration_s AS "durationS", polyline
           FROM route_cache
          WHERE cache_key = $1 AND expires_at > now()`,
          [key]
    );
    if (cached.rows[0]) {
        return cached.rows[0];
    }

    const route = await fetchRoute(from, to);

    await pool.query(
        `INSERT INTO route_cache (cache_key, distance_m, duration_s, polyline, expires_at)
         VALUES ($1, $2, $3, $4, now() + ($5::int * interval '1 day'))
         ON CONFLICT (cache_key) DO UPDATE SET
            distance_m = EXCLUDED.distance_m,
            duration_s = EXCLUDED.duration_s,
            polyline   = EXCLUDED.polyline,
            fetched_at = now(),
            expires_at = EXCLUDED.expires_at`,
        [key, route.distanceM, route.durationS, route.polyline, CACHE_TTL_DAYS]
    );
    return route;
}

// Road route from one point to another (restaurant -> delivery address), cached for 7 days.
function getRoute(fromPoint: Point, toPoint: Point): Promise<Route> {
    const from = roundPoint(fromPoint);
    const to = roundPoint(toPoint);
    const key = `osrm:v1:${from.lat},${from.lng}:${to.lat},${to.lng}`;

    const running = inFlight.get(key);
    if (running) {
        return running;
    }
    const promise = loadRoute(key, from, to).finally(() => inFlight.delete(key));
    inFlight.set(key, promise);
    return promise;
}

export { getRoute };