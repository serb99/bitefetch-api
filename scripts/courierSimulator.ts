/**
 * Courier simulator: a fleet of fake phones that use only the public API.
 * Every courier starts at a random spot near a restaurant; dispatch offers the order to the nearest one.
 *
 *   npm run simulate:courier                              2 to 6 couriers (random), near open restaurants
 *   npm run simulate:courier -- --couriers 3              courier1..courier3
 *   npm run simulate:courier -- --restaurant napoli       everyone starts near "Pizza Napoli Centru"
 *   npm run simulate:courier -- --email courier2@bitefetch.local --answer decline   just this one
 *   npm run simulate:courier -- --lat 46.77 --lng 23.59   everyone starts exactly there
 *
 * --answer accept|decline|ignore   --speedup 10   --once (stop after the first delivery)   --api URL
 * Ctrl+C: stop and every courier goes offline.
 */
import { parseArgs } from 'node:util';
import type { listNearbyRestaurants } from '../src/services/browseService';
import { ApiClient, ApiCallError } from './lib/apiClient';
import { runCourierBot, type Answer } from './lib/courierBot';
import { randomPointNear, type LatLng } from './lib/movement';

type NearbyRestaurant = Awaited<ReturnType<typeof listNearbyRestaurants>>[number];

const ANSWERS: readonly Answer[] = ['accept', 'decline', 'ignore'];

// The seed creates courier1..courier6 (npm run seed), all with the seed password
const SEEDED_COURIERS = 6;
const DEFAULT_MIN_COURIERS = 2;
const SEED_DOMAIN = 'bitefetch.local';

// Where to look for restaurants. The seed puts every restaurant in Cluj-Napoca;
// for another city pass --lat/--lng.
const SEARCH_CENTER: LatLng = { lat: 46.7712, lng: 23.5899 };
const SEARCH_RADIUS_KM = 25; // the maximum GET /restaurants accepts

// Close enough to get offers (dispatch looks 10 km around), far enough to drive a bit
const START_MIN_M = 300;
const START_MAX_M = 1_500;

function randomInt(min: number, max: number): number {
    return min + Math.floor(Math.random() * (max - min + 1));
}

// Asks the API where the restaurants are (public endpoint, no login) and keeps the ones to start near
async function findRestaurants(api: ApiClient, wanted: string | undefined): Promise<NearbyRestaurant[]> {
    const { lat, lng } = SEARCH_CENTER;
    const all = await api.call<NearbyRestaurant[]>('GET', `/restaurants?lat=${lat}&lng=${lng}&radiusKm=${SEARCH_RADIUS_KM}`);
    if (all.length === 0) throw new Error('No restaurants found. Did you run npm run seed?');

    if (wanted) {
        const matches = all.filter((r) => r.name.toLowerCase().includes(wanted.toLowerCase()));
        if (matches.length === 0) {
            throw new Error(`No restaurant matches "${wanted}". Known: ${all.map((r) => r.name).join(', ')}`);
        }
        return matches;
    }
    // Orders only come from open restaurants; if none is open, any will do
    const open = all.filter((r) => r.orderable);
    return open.length > 0 ? open : all;
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        options: {
            api: { type: 'string', default: 'http://localhost:3000' },
            couriers: { type: 'string' },   // how many seed couriers; default random 2..6
            email: { type: 'string' },      // one specific courier instead of the fleet
            password: { type: 'string', default: 'Password123!' }, // the seed password
            answer: { type: 'string', default: 'accept' },
            speedup: { type: 'string', default: '10' },
            restaurant: { type: 'string' }, // part of the name, any case
            lat: { type: 'string' },        // exact start; skips the restaurant lookup
            lng: { type: 'string' },
            once: { type: 'boolean', default: false }
        }
    });

    const answer = ANSWERS.find((a) => a === values.answer);
    const speedup = Number(values.speedup);
    const count = values.couriers === undefined ? randomInt(DEFAULT_MIN_COURIERS, SEEDED_COURIERS) : Number(values.couriers);
    if (
        !answer ||
        !(speedup > 0) ||
        !Number.isInteger(count) || count < 1 || count > SEEDED_COURIERS ||
        (values.lat === undefined) !== (values.lng === undefined)
    ) {
        throw new Error('Bad arguments, see the top of scripts/courierSimulator.ts');
    }

    const emails = values.email
        ? [values.email]
        : Array.from({ length: count }, (_, i) => `courier${i + 1}@${SEED_DOMAIN}`);

    // Starting points: exact, or one random restaurant + random spot per courier
    let startFor: () => { start: LatLng; near: string };
    if (values.lat !== undefined && values.lng !== undefined) {
        const exact = { lat: Number(values.lat), lng: Number(values.lng) };
        if (!Number.isFinite(exact.lat) || !Number.isFinite(exact.lng)) throw new Error('--lat and --lng must be numbers');
        startFor = () => ({ start: exact, near: 'the given point' });
    } else {
        const restaurants = await findRestaurants(new ApiClient(values.api, { email: '', password: '' }), values.restaurant);
        startFor = () => {
            const r = restaurants[Math.floor(Math.random() * restaurants.length)];
            return { start: randomPointNear(r, START_MIN_M, START_MAX_M), near: r.name };
        };
    }

    // One abort for the whole fleet: Ctrl+C, or the first delivery with --once
    const stop = new AbortController();
    process.once('SIGINT', () => stop.abort());

    const width = Math.max(...emails.map((e) => e.split('@')[0].length));
    console.log(`Starting ${emails.length} courier(s)`);

    const results = await Promise.allSettled(
        emails.map((email) => {
            const name = email.split('@')[0].padEnd(width);
            const log = (message: string) => console.log(`${new Date().toLocaleTimeString()} [${name}] ${message}`);
            const { start, near } = startFor();
            log(`starts near ${near}`);
            return runCourierBot({
                api: new ApiClient(values.api, { email, password: values.password }),
                start,
                speedup,
                answer,
                signal: stop.signal,
                onDelivered: values.once ? () => stop.abort() : undefined,
                log
            });
        })
    );

    // A courier that could not start (no seed account, not a courier, ...) does not stop the others
    let delivered = 0;
    results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
            delivered += result.value;
            return;
        }
        const err = result.reason;
        const why = err instanceof ApiCallError ? `${err.status} ${err.code}: ${err.message}` : err instanceof Error ? err.message : String(err);
        console.error(`${emails[i]} could not run: ${why}`);
        if (err instanceof ApiCallError && err.code === 'INVALID_CREDENTIALS') console.error('  (run npm run seed to create courier3..courier6)');
    });
    console.log(`Delivered: ${delivered}`);
    if (results.some((r) => r.status === 'rejected')) process.exitCode = 1;
}

main().catch((err: unknown) => {
    if (err instanceof ApiCallError) console.error(`${err.status} ${err.code}: ${err.message}`);
    else console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
