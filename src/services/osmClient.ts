import { AppError } from '../errors/AppError';

type SearchKind = 'restaurant' | 'address';

type OsmPlace = {
    osmId: string; // 'node/123456'
    name: string | null;
    displayName: string;
    address: string | null;
    lat: number;
    lng: number;
    phone: string | null;
    brand: string | null;
};
type NominatimResult = {
    osm_type: string;
    osm_id: number | string;
    lat: string;
    lon: string;
    category: string;
    type: string;
    name?: string;
    display_name: string;
    address?: Record<string, string>;
    extratags?: Record<string, string> | null;
};

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = process.env.OSM_USER_AGENT || 'BiteFetch/0.1';
const RESTAURANT_TYPES = new Set(['restaurant', 'cafe', 'fast_food']);
const COUNTRIES = process.env.OSM_COUNTRIES || 'ro';
// minimum time between two requests to Nominatim (their policy: about 1 per second)
const MIN_GAP_MS = Number(process.env.OSM_MIN_GAP_MS ?? 1100);

let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

const osmUnavailable = () =>
    new AppError(502, 'OSM_UNAVAILABLE', 'The map service is not available right now');

function throttled<T>(task: () => Promise<T>): Promise<T> {
    const run = queue.then(async () => {
        const wait = lastCallAt + MIN_GAP_MS - Date.now();
        if (wait > 0){
            await new Promise((resolve) => setTimeout(resolve, wait));
        }
        lastCallAt = Date.now();
        return task();
    })

    //the next caller waits for this one, whether it succeeded or failed
    queue = run.catch(() => undefined);

    return run;
}

function toPlace(r: NominatimResult): OsmPlace {
    const a = r.address ?? {};
    const street = [a.road, a.house_number].filter(Boolean).join(' ');
    const city = a.city ?? a.town ?? a.village;

    return {
        osmId: `${r.osm_type}/${r.osm_id}`,
        name: r.name || null,
        displayName: r.display_name,
        address: [street, city].filter(Boolean).join(', ') || null,
        lat: Number(r.lat),
        lng: Number(r.lon),
        phone: r.extratags?.phone ?? r.extratags?.['contact:phone'] ?? null,
        brand: r.extratags?.brand ?? null,
    }
}

async function searchNominatim(kind: SearchKind, text: string): Promise<OsmPlace[]> {
    const params = new URLSearchParams({
        q: text,
        format: 'jsonv2',
        addressdetails: '1',
        extratags: '1',
        limit: kind === 'restaurant' ? '20' : '10',
        countrycodes: COUNTRIES,
        'accept-language': 'ro,en',
    });

    let res: Response;
    try {
        res = await throttled(() =>
            fetch(`${NOMINATIM_URL}?${params}`, {
                headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
                signal: AbortSignal.timeout(5000),
            }),
        );
    }catch {
        throw osmUnavailable();
    }

    if (!res.ok) {
        throw osmUnavailable();
    }

    let raw: NominatimResult[];

    try {
        const body: unknown = await res.json();
        if (!Array.isArray(body)) throw new Error('unexpected answer');
        raw = body as NominatimResult[];
    } catch {
        throw osmUnavailable();
    }

    const wanted = kind === 'restaurant'
                         ? raw.filter((r) => r.category === 'amenity' && RESTAURANT_TYPES.has(r.type))
                         : raw;
    
    return wanted.slice(0, 10).map(toPlace);
}

export { searchNominatim, COUNTRIES };
export type { OsmPlace, SearchKind };