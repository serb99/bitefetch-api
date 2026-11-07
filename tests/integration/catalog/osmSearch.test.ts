import { api } from '../../helpers/http';
import { pool } from '../../helpers/db';
import { COUNTRIES } from '../../../src/services/osmClient';

// Nominatim is never called for real: global fetch is mocked in every test.

const OSM_UNAVAILABLE = { error: { code: 'OSM_UNAVAILABLE', message: 'The map service is not available right now', details: null } };

function nominatim(overrides: Record<string, unknown> = {}) {
    return {
        osm_type: 'node', osm_id: 1001, lat: '45.6427', lon: '25.5887',
        category: 'amenity', type: 'restaurant', name: 'Casa Ana',
        display_name: 'Casa Ana, Strada Lunga 5, Brasov, Romania',
        address: { road: 'Strada Lunga', house_number: '5', city: 'Brasov' },
        extratags: { 'contact:phone': '+40 268 000 000' },
        ...overrides,
    };
}

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: jest.SpyInstance;
beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => json([nominatim()]));
});

const search = (kind: 'restaurants' | 'addresses', q?: string) =>
    q === undefined ? api().get(`/osm/${kind}`) : api().get(`/osm/${kind}`).query({ q });

const calledUrl = (call = 0) => new URL(String(fetchMock.mock.calls[call][0]));

describe('GET /osm/restaurants', () => {
    it('returns the places mapped to our shape', async () => {
        const res = await search('restaurants', 'casa ana brasov');

        expect(res.status).toBe(200);
        expect(res.body).toEqual([{
            osmId: 'node/1001', name: 'Casa Ana', displayName: 'Casa Ana, Strada Lunga 5, Brasov, Romania',
            address: 'Strada Lunga 5, Brasov', lat: 45.6427, lng: 25.5887, phone: '+40 268 000 000', brand: null,
        }]);
    });

    it('calls Nominatim with a User-Agent, the country list and limit 20', async () => {
        await search('restaurants', 'casa ana');

        const url = calledUrl();
        expect(url.origin + url.pathname).toBe('https://nominatim.openstreetmap.org/search');
        expect(Object.fromEntries(url.searchParams)).toMatchObject({
            q: 'casa ana', format: 'jsonv2', limit: '20', countrycodes: COUNTRIES, addressdetails: '1', extratags: '1',
        });
        const init = fetchMock.mock.calls[0][1] as RequestInit;
        expect((init.headers as Record<string, string>)['User-Agent']).toMatch(/^BiteFetch/);
    });

    it('keeps only restaurants, cafes and fast food, at most 10', async () => {
        const places = [
            nominatim({ osm_id: 1, type: 'cafe' }),
            nominatim({ osm_id: 2, type: 'fast_food' }),
            nominatim({ osm_id: 3, category: 'shop', type: 'bakery' }),
            nominatim({ osm_id: 4, type: 'bar' }),
            ...Array.from({ length: 12 }, (_, i) => nominatim({ osm_id: 100 + i })),
        ];
        fetchMock.mockImplementation(async () => json(places));

        const res = await search('restaurants', 'food brasov');

        expect(res.body).toHaveLength(10);
        const ids = res.body.map((p: { osmId: string }) => p.osmId);
        expect(ids.slice(0, 2)).toEqual(['node/1', 'node/2']);
        expect(ids).not.toContain('node/3');
        expect(ids).not.toContain('node/4');
    });

    it('fills missing values: name from null, town instead of city, brand and phone tags', async () => {
        fetchMock.mockImplementation(async () => json([nominatim({
            name: '', address: { road: 'DN1', town: 'Predeal' }, extratags: { phone: '0268 111', brand: "McDonald's" },
        }), nominatim({ osm_id: 2, address: {}, extratags: null })]));

        const res = await search('restaurants', 'predeal');

        expect(res.body[0]).toMatchObject({ name: null, address: 'DN1, Predeal', phone: '0268 111', brand: "McDonald's" });
        expect(res.body[1]).toMatchObject({ address: null, phone: null, brand: null });
    });

    it('stores the answer in osm_search_cache for 30 days under a normalized key', async () => {
        await search('restaurants', '  Casa   ANA ');

        const { rows } = await pool.query(
            `SELECT query_key, query, results,
                    round(extract(epoch FROM expires_at - fetched_at) / 86400) AS days
               FROM osm_search_cache`);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
            query_key: `restaurant|${COUNTRIES}|casa ana`,
            query: { kind: 'restaurant', text: 'casa ana', countries: COUNTRIES },
            days: '30',
        });
        expect(rows[0].results[0].osmId).toBe('node/1001');
    });

    it('answers a repeated search (different spacing and case) from the cache', async () => {
        const first = await search('restaurants', 'casa ana');
        const second = await search('restaurants', ' CASA  ana');

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(second.body).toEqual(first.body);
    });

    it('asks Nominatim again when the cached answer has expired, and replaces it', async () => {
        await search('restaurants', 'casa ana');
        await pool.query(`UPDATE osm_search_cache SET expires_at = now() - interval '1 second'`);
        fetchMock.mockImplementation(async () => json([nominatim({ osm_id: 2002 })]));

        const res = await search('restaurants', 'casa ana');

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(res.body[0].osmId).toBe('node/2002');
        const { rows } = await pool.query('SELECT results, expires_at > now() AS fresh FROM osm_search_cache');
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ fresh: true, results: [expect.objectContaining({ osmId: 'node/2002' })] });
    });

    it('shares one Nominatim call between identical searches that run at the same time', async () => {
        fetchMock.mockImplementation(async () => {
            await new Promise((resolve) => setTimeout(resolve, 200));
            return json([nominatim()]);
        });

        const answers = await Promise.all([
            search('restaurants', 'casa ana'),
            search('restaurants', 'Casa Ana'),
            search('restaurants', 'casa  ana'),
        ]);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        for (const res of answers) {
            expect(res.status).toBe(200);
            expect(res.body[0].osmId).toBe('node/1001');
        }
    });

    it('caches an empty answer too', async () => {
        fetchMock.mockImplementation(async () => json([]));

        expect((await search('restaurants', 'nothing here')).body).toEqual([]);
        expect((await search('restaurants', 'nothing here')).body).toEqual([]);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    describe('when Nominatim fails', () => {
        it.each([
            ['the request throws (network error or timeout)', async () => { throw new TypeError('fetch failed'); }],
            ['it answers 503', async () => json({ error: 'busy' }, 503)],
            ['the body is not JSON', async () => new Response('<html>', { status: 200 })],
            ['the body is not an array', async () => json({ error: 'odd' })],
        ])('answers 502 OSM_UNAVAILABLE when %s, caches nothing, and retries next time', async (_case, impl) => {
            fetchMock.mockImplementation(impl);

            const res = await search('restaurants', 'casa ana');

            expect(res.status).toBe(502);
            expect(res.body).toEqual(OSM_UNAVAILABLE);
            expect((await pool.query('SELECT 1 FROM osm_search_cache')).rowCount).toBe(0);

            fetchMock.mockImplementation(async () => json([nominatim()]));
            const retry = await search('restaurants', 'casa ana');
            expect(retry.status).toBe(200);
            expect(fetchMock).toHaveBeenCalledTimes(2);
        });
    });

    it.each([
        ['no q', undefined],
        ['q shorter than 3 characters after trimming', '  ab  '],
        ['q longer than 100 characters', 'x'.repeat(101)],
    ])('rejects %s with 400 without calling Nominatim', async (_case, q) => {
        const res = await search('restaurants', q);

        expect(res.status).toBe(400);
        expect(res.body.error).toMatchObject({ code: 'VALIDATION_ERROR', message: 'Invalid query parameters' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('needs no login', async () => {
        expect((await search('restaurants', 'casa ana')).status).toBe(200);
    });
});

describe('GET /osm/addresses', () => {
    it('keeps every kind of place, asks for 10 results and uses its own cache key', async () => {
        fetchMock.mockImplementation(async () => json([
            nominatim({ category: 'highway', type: 'residential', name: 'Strada Lunga' }),
            nominatim({ osm_id: 2, category: 'place', type: 'house', name: '' }),
        ]));

        const res = await search('addresses', 'strada lunga');

        expect(res.status).toBe(200);
        expect(res.body).toHaveLength(2);
        expect(calledUrl().searchParams.get('limit')).toBe('10');
        const { rows } = await pool.query('SELECT query_key FROM osm_search_cache');
        expect(rows).toEqual([{ query_key: `address|${COUNTRIES}|strada lunga` }]);
    });

    it('does not share the cache with a restaurant search for the same text', async () => {
        await search('restaurants', 'casa ana');
        await search('addresses', 'casa ana');

        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('throttle', () => {
    // env.ts sets OSM_MIN_GAP_MS=0 for the other tests; load a fresh copy of the client with a real gap.
    it('leaves at least OSM_MIN_GAP_MS between two Nominatim calls, also after a failure', async () => {
        const previous = process.env.OSM_MIN_GAP_MS;
        process.env.OSM_MIN_GAP_MS = '300';
        let client!: typeof import('../../../src/services/osmClient');
        jest.isolateModules(() => { client = require('../../../src/services/osmClient'); });
        process.env.OSM_MIN_GAP_MS = previous;

        const startedAt: number[] = [];
        let n = 0;
        fetchMock.mockImplementation(async () => {
            startedAt.push(Date.now());
            n += 1;
            if (n === 2) throw new TypeError('fetch failed');
            return json([nominatim()]);
        });

        const results = await Promise.allSettled([
            client.searchNominatim('restaurant', 'one'),
            client.searchNominatim('restaurant', 'two'),
            client.searchNominatim('restaurant', 'three'),
        ]);

        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
        expect(startedAt).toHaveLength(3);
        expect(startedAt[1] - startedAt[0]).toBeGreaterThanOrEqual(290);
        expect(startedAt[2] - startedAt[1]).toBeGreaterThanOrEqual(290);
    });
});

describe('rate limit', () => {
    const previous = process.env.RATE_LIMIT_DISABLED;
    beforeAll(() => { process.env.RATE_LIMIT_DISABLED = 'false'; });
    afterAll(() => { process.env.RATE_LIMIT_DISABLED = previous; });

    it('allows 20 searches a minute per IP across both endpoints, then answers 429', async () => {
        // the limiter runs before validation, so invalid (cheap) requests count too
        for (let i = 0; i < 10; i++) {
            expect((await search('restaurants', 'ab')).status).toBe(400);
            expect((await search('addresses', 'ab')).status).toBe(400);
        }

        const res = await search('restaurants', 'casa ana');

        expect(res.status).toBe(429);
        expect(res.body.error.code).toBe('RATE_LIMITED');
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
