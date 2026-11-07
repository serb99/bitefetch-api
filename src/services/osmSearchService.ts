import { pool } from '../database/pool';
import { searchNominatim, COUNTRIES } from './osmClient';
import type { OsmPlace, SearchKind } from './osmClient';

const CACHE_TTL_DAYS = 30;

// searches that are running right now, by cache key
const inFlight = new Map<string, Promise<OsmPlace[]>>();

function normalize(text: string): string {
    return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

async function loadPlaces(kind: SearchKind, normalized: string, key: string): Promise<OsmPlace[]> {
    // return the answer if the cache didn't expire and the query key exists
    const hit = await pool.query<{ results: OsmPlace[] }>(
        `SELECT results
           FROM osm_search_cache
          WHERE query_key = $1 AND expires_at > now()`, 
        [key]
    );
    if (hit.rows[0]) {
        return hit.rows[0].results;
    }

    // if the result is expired or not found in cache then ask OSM for an answer
    const results = await searchNominatim(kind, normalized);

    // save the answer, replacing an expired one if there is one
    await pool.query(
        `INSERT INTO osm_search_cache (query_key, query, results, expires_at)
         VALUES ($1, $2::jsonb, $3::jsonb, now() + ($4::int * interval '1 day'))
         ON CONFLICT (query_key)
         DO UPDATE SET query = EXCLUDED.query,
                       results = EXCLUDED.results,
                       fetched_at = now(),
                       expires_at = EXCLUDED.expires_at`,
        [
            key,
            JSON.stringify({ kind, text: normalized, countries: COUNTRIES }),
            JSON.stringify(results),
            CACHE_TTL_DAYS
        ]
    );

    return results;
}

function searchPlaces(kind: SearchKind, text: string): Promise<OsmPlace[]> {
    const normalized = normalize(text);
    const key = `${kind}|${COUNTRIES}|${normalized}`;

    // the same search is already running: share its result
    const running = inFlight.get(key); 
    if (running){
        return running;
    }

    const promise = loadPlaces(kind, normalized, key).finally(() => {
        inFlight.delete(key);
    })
    inFlight.set(key, promise);

    return promise;
}

export { searchPlaces };