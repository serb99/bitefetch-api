/**
 * Robot runner (M9b): drives the BiteFetch robot couriers robot1..robot6 through the public API.
 * It never decides WHO works: the worker (job robot-start) puts a robot online at the restaurant of a robot order
 * and the dispatch offers it the order. This process only notices "my robot is online and has work", then
 * accepts, drives, picks up and delivers, and puts the robot offline again (scripts/lib/courierBot, managed mode).
 *
 *   npm run robots                    all six robots, 10x faster than real (a sidewalk robot is slow: 6 km/h)
 *   npm run robots -- --speedup 1     real speed
 *   npm run robots -- --robots 3      robot1..robot3 only (the sidewalk robots)
 *
 * --api URL (default http://localhost:3000)   --password (the seed password)
 * Needs the API and the worker running. Refuses to start without a Stripe TEST key in .env: robot orders are
 * paid with test cards only (with a live key a robot "delivery" would capture a real card).
 *
 * Ctrl+C once: no new jobs, the robots on a delivery finish it first (stopping mid-delivery leaves the order
 * stuck in picked_up). Ctrl+C twice: stop now, every robot goes offline.
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CourierState } from '../src/services/courierService';
import type { CurrentOffer } from '../src/services/courierOfferService';
import type { CourierOrder } from '../src/services/courierOrderService';
import { ApiClient, ApiCallError } from './lib/apiClient';
import { runCourierBot } from './lib/courierBot';
import type { LatLng } from './lib/movement';

const SEEDED_ROBOTS = 6;
const SEED_DOMAIN = 'bitefetch.local';
const POLL_MS = 3_000;

type Robot = { name: string; api: ApiClient };

function describe(err: unknown): string {
    if (err instanceof ApiCallError) return `${err.status} ${err.code}: ${err.message}`;
    return err instanceof Error ? err.message : String(err);
}

// Where the robot starts driving: the worker parked it at the restaurant of its offer. After a runner
// restart in the middle of a job, the restaurant (or the customer, once picked up) is close enough.
async function findWork(robot: Robot): Promise<LatLng | null> {
    const state = await robot.api.call<CourierState>('GET', '/courier');
    if (state.availability !== 'online') return null;

    const { order } = await robot.api.call<{ order: CourierOrder | null }>('GET', '/courier/orders/current');
    if (order) return order.status === 'picked_up' ? order.customer : order.restaurant;

    const { offer } = await robot.api.call<{ offer: CurrentOffer | null }>('GET', '/courier/offers/current');
    return offer ? offer.restaurant : null;
}

// One robot, forever: wait for work, do it, wait again. `noNewJobs` = the first Ctrl+C, `stopNow` = the second.
async function superviseRobot(robot: Robot, speedup: number, noNewJobs: AbortSignal, stopNow: AbortSignal): Promise<number> {
    const log = (message: string) => console.log(`${new Date().toLocaleTimeString()} [${robot.name}] ${message}`);
    let delivered = 0;
    let lastError = '';

    await robot.api.login();
    log('ready');

    while (!noNewJobs.aborted) {
        try {
            const start = await findWork(robot);
            lastError = '';
            if (start) {
                // Only lat/lng: the position body is strict
                delivered += await runCourierBot({
                    api: robot.api,
                    start: { lat: start.lat, lng: start.lng },
                    speedup,
                    answer: 'accept',
                    signal: stopNow,
                    managed: true,
                    log,
                });
            }
        } catch (err) {
            const message = describe(err);
            if (message !== lastError) log(`cannot check for work: ${message}`);
            lastError = message;
        }
        await sleep(POLL_MS, undefined, { signal: noNewJobs }).catch(() => undefined);
    }
    return delivered;
}

async function main(): Promise<void> {
    // The same rule as checkout (deliveryQuoteService.robotsEnabled): robots only with a Stripe test key
    if (!(process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_test_')) {
        throw new Error('Refusing to start: STRIPE_SECRET_KEY in .env is not a test key (sk_test_...). Robots only deliver test orders.');
    }

    const { values } = parseArgs({
        options: {
            api: { type: 'string', default: 'http://localhost:3000' },
            password: { type: 'string', default: 'Password123!' },
            speedup: { type: 'string', default: '10' },
            robots: { type: 'string', default: String(SEEDED_ROBOTS) },
        },
    });
    const speedup = Number(values.speedup);
    const count = Number(values.robots);
    if (!(speedup > 0) || !Number.isInteger(count) || count < 1 || count > SEEDED_ROBOTS) {
        throw new Error('Bad arguments, see the top of scripts/robotRunner.ts');
    }

    const noNewJobs = new AbortController();
    const stopNow = new AbortController();
    process.on('SIGINT', () => {
        if (!noNewJobs.signal.aborted) {
            console.log('Stopping: no new jobs; robots on a delivery finish it first. Ctrl+C again to stop now.');
            noNewJobs.abort();
        } else {
            console.log('Stopping now: every robot goes offline.');
            stopNow.abort();
        }
    });

    const robots: Robot[] = Array.from({ length: count }, (_, i) => {
        const email = `robot${i + 1}@${SEED_DOMAIN}`;
        return { name: `robot${i + 1}`, api: new ApiClient(values.api, { email, password: values.password }) };
    });
    console.log(`Robot runner: ${count} robot(s), speedup ${speedup}. Waiting for robot orders...`);

    const results = await Promise.allSettled(robots.map((r) => superviseRobot(r, speedup, noNewJobs.signal, stopNow.signal)));

    let delivered = 0;
    results.forEach((result, i) => {
        if (result.status === 'fulfilled') {
            delivered += result.value;
            return;
        }
        console.error(`${robots[i].name} could not run: ${describe(result.reason)}`);
        if (result.reason instanceof ApiCallError && result.reason.code === 'INVALID_CREDENTIALS') {
            console.error('  (run npm run seed to create robot1..robot6)');
        }
    });
    console.log(`Delivered: ${delivered}`);
    if (results.some((r) => r.status === 'rejected')) process.exitCode = 1;
}

main().catch((err: unknown) => {
    console.error(describe(err));
    process.exitCode = 1;
});
