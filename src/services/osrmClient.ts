import { AppError } from '../errors/AppError';

type Point = { lat: number; lng: number };
type Route = { distanceM: number; durationS: number; polyline: string };

type OsrmResponse = {
    code: string;
    routes?: { distance: number; duration: number; geometry: string }[];
};

const OSRM_URL = process.env.OSRM_BASE_URL || 'https://router.project-osrm.org';
const USER_AGENT = process.env.OSM_USER_AGENT || 'BiteFetch/0.1';
const MIN_GAP_MS = Number(process.env.OSRM_MIN_GAP_MS ?? 1100);

//calls wait in a queue, at least MIN_GAP_MS apart.
let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

function throttled<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(async () => {
        const wait = lastCallAt + MIN_GAP_MS - Date.now();
        if (wait > 0) {
            await new Promise((resolve) => setTimeout(resolve, wait));
        }
        lastCallAt = Date.now(); 
        return task();
    })
    queue = run.catch(() => undefined); // one failed call must not block the queue
    return run;
}

function routingUnavailable(): AppError {
    return new AppError(502, 'ROUTING_UNAVAILABLE', 'The delivery distance is not available right now, try again');
}

async function fetchRoute(from: Point, to: Point): Promise<Route> {
    // OSRM wants LONGITUDE first: lng,lat
    const coordinates = `${from.lng},${from.lat};${to.lng},${to.lat}`;
    const url = `${OSRM_URL}/route/v1/driving/${coordinates}?overview=full&geometries=polyline`;

    let res: Response;
    try {
        res = await throttled(() => 
            fetch(url, {
                headers: { 'User-Agent': USER_AGENT },
                signal: AbortSignal.timeout(5000)
            })
        );
    } catch {
        throw routingUnavailable();
    }

    const body = (await res.json().catch(() => null)) as OsrmResponse | null;

    // the address is not near a road we can drive to
    if (body?.code === 'NoRoute' || body?.code === 'NoSegment') {
        throw new AppError(422, 'NO_ROUTE', 'We cannot find a road route to this address');
    }

    const route = body?.routes?.[0];
    if (!res.ok || body?.code !== 'Ok' || !route) {
        throw routingUnavailable();
    }

    return {
        distanceM: Math.round(route.distance),
        durationS: Math.round(route.duration),
        polyline: route.geometry
    };
}

export { fetchRoute };
export type { Point, Route };