/**
 * Happy path, end to end through the real API (checkpoint D1):
 * signup -> activate -> address -> cart -> checkout -> pay -> placed (webhook) -> accept -> ready
 * -> courier offer -> pickup -> delivered -> payment captured.
 *
 * Needs, all running locally:
 *   1. the API (npm run dev), with migrations + npm run seed done
 *   2. stripe listen --forward-to localhost:3000/webhooks/stripe   (the "placed" step waits for its webhook)
 *
 *   npm run happy-path
 *   npm run happy-path -- --runs 5                       checkpoint D1: five in a row
 *   npm run happy-path -- --owner ion@bitefetch.local    order from Pizza Napoli Centru instead
 *   npm run happy-path -- --mode robot                   M9b: a BiteFetch robot delivers (cheaper fee). Needs
 *                                                        the worker and `npm run robots` too, and no human courier
 *
 * --courier EMAIL (default courier1, human mode only)   --speedup 20   --api URL (local only)
 */
import 'dotenv/config';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { pool } from '../src/database/pool';
import { stripe } from '../src/services/stripeClient';
import { generateToken, hashToken } from '../src/utils/tokens';
import type { OrderView } from '../src/services/orderService';
import type { CartView } from '../src/services/cartService';
import type { Address } from '../src/services/addressService';
import type { OrderTracking } from '../src/services/trackingService';
import type { DeliveryMode } from '../src/schemas/checkoutSchema';
import { ApiClient, ApiCallError } from './lib/apiClient';
import { runCourierBot } from './lib/courierBot';
import { randomPointNear } from './lib/movement';

const PASSWORD = 'Password123!';
const DOMAIN = 'bitefetch.local';

// How long each wait may take before the run counts as failed
const COURIER_ONLINE_WAIT_MS = 20_000; // bot start -> online (first position, then availability)
const WEBHOOK_WAIT_MS = 30_000;   // pay -> placed
const DELIVERY_WAIT_MS = 300_000; // ready -> delivered (dispatch deadline in dev is 180 s)
const CAPTURE_WAIT_MS = 60_000;   // delivered -> captured (the payment timer runs every 5 s)
const POLL_MS = 1_000;

// Statuses an order passes through on the happy path; anything else is the end of the run
const ON_THE_WAY = ['placed', 'accepted', 'ready_for_pickup', 'picked_up', 'delivered'];

type OwnRestaurant = { id: string; name: string; lat: number; lng: number };
type MenuItem = { id: string; name: string; priceMinor: number; available: boolean };
type Menu = { restaurant: { orderable: boolean }; categories: { items: MenuItem[] }[] };
type PlacedOrder = OrderView & { clientSecret: string | null };

class RunFailed extends Error {}

// "409 RESTAURANT_CLOSED: ..." for API errors, the message for everything else
function describe(err: unknown): string {
    if (err instanceof ApiCallError) return `${err.status} ${err.code}: ${err.message}`;
    return err instanceof Error ? err.message : String(err);
}

// Asks `check` every second until it returns a value, or gives up after timeoutMs
async function waitFor<T>(what: string, timeoutMs: number, check: () => Promise<T | undefined>): Promise<T> {
    const giveUpAt = Date.now() + timeoutMs;
    while (Date.now() < giveUpAt) {
        const value = await check();
        if (value !== undefined) return value;
        await sleep(POLL_MS);
    }
    throw new RunFailed(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
}

// The activation link only goes to the server log (no email in dev). The script writes its own token
// into the dev database, then calls the real endpoint: the same check as a click on the link.
async function activate(api: ApiClient, userId: string): Promise<void> {
    const token = generateToken();
    await pool.query(
        `INSERT INTO email_tokens (user_id, type, token_hash, expires_at)
         VALUES ($1, 'activation', $2, now() + interval '1 hour')`,
        [userId, hashToken(token)]
    );
    await api.call('POST', '/account-activations', { token });
}

type RunOptions = { apiUrl: string; ownerEmail: string; courierEmail: string; speedup: number; mode: DeliveryMode };

// Human mode: our own courier bot goes online near the restaurant (before the checkout: the T1 guard needs a
// fresh courier within 10 km). Robot mode: nothing here, the worker starts a robot and `npm run robots` drives it.
// Returns a check for "has the courier stopped?" and the stop function.
async function startCourier(
    options: RunOptions,
    restaurant: OwnRestaurant,
    step: (message: string) => void
): Promise<{ stopped: () => string | null; stop: () => Promise<void> }> {
    if (options.mode === 'robot') {
        return { stopped: () => null, stop: async () => undefined };
    }

    const stopCourier = new AbortController();
    const courierName = options.courierEmail.split('@')[0];
    // A courier that cannot start (wrong password, no profile) must fail the run, not hang it
    let courierStopped: string | null = null;
    const courier = runCourierBot({
        api: new ApiClient(options.apiUrl, { email: options.courierEmail, password: PASSWORD }),
        start: randomPointNear(restaurant, 300, 1_500),
        speedup: options.speedup,
        answer: 'accept',
        signal: stopCourier.signal,
        log: (message) => step(`[${courierName}] ${message}`)
    }).then(
        () => { courierStopped = 'it went offline'; },
        (err: unknown) => { courierStopped = describe(err); }
    );
    const stopped = () => (courierStopped ? `${courierName} stopped: ${courierStopped}` : null);
    const stop = async () => {
        stopCourier.abort(); // the bot goes offline
        await courier;
    };

    try {
        const courierView = new ApiClient(options.apiUrl, { email: options.courierEmail, password: PASSWORD });
        await courierView.login();
        await waitFor('the courier to go online', COURIER_ONLINE_WAIT_MS, async () => {
            const why = stopped();
            if (why) throw new RunFailed(why);
            const state = await courierView.call<{ availability: string }>('GET', '/courier');
            return state.availability === 'online' ? state : undefined;
        });
    } catch (err) {
        await stop();
        throw err;
    }
    return { stopped, stop };
}

async function happyPath(options: RunOptions): Promise<void> {
    const startedAt = Date.now();
    const step = (message: string) => console.log(`  ${((Date.now() - startedAt) / 1000).toFixed(1).padStart(5)} s  ${message}`);

    // 1. The restaurant, from its owner: no names or ids hardcoded
    const owner = new ApiClient(options.apiUrl, { email: options.ownerEmail, password: PASSWORD });
    await owner.login();
    const restaurant = await owner.call<OwnRestaurant>('GET', '/owner/restaurant');
    const menu = await owner.call<Menu>('GET', `/restaurants/${restaurant.id}/menu`);
    if (!menu.restaurant.orderable) {
        throw new RunFailed(`${restaurant.name} is not taking orders now (opening hours, closed or paused)`);
    }
    const item = menu.categories.flatMap((c) => c.items).find((i) => i.available);
    if (!item) throw new RunFailed(`${restaurant.name} has no available menu item`);
    step(`restaurant: ${restaurant.name}`);

    // 2. A new customer every run: signup, activation, login
    const email = `happy-${Date.now()}@${DOMAIN}`;
    const customer = new ApiClient(options.apiUrl, { email, password: PASSWORD });
    const { user } = await customer.call<{ user: { id: string } }>('POST', '/customers', {
        email,
        password: PASSWORD,
        fullName: 'Happy Path'
    });
    await activate(customer, user.id);
    await customer.login();
    step(`customer ${email} signed up and activated`);

    // 3. Address 0.8-2 km from the restaurant, cart over the minimum order
    const home = randomPointNear(restaurant, 800, 2_000);
    const address = await customer.call<Address>('POST', '/addresses', {
        label: 'Happy path',
        street: 'Strada Test 1',
        city: 'Cluj-Napoca',
        ...home
    });
    const empty = await customer.call<CartView>('GET', '/cart');
    const quantity = Math.min(50, Math.max(1, Math.ceil(empty.minOrderMinor / item.priceMinor)));
    await customer.call('PUT', `/cart/items/${item.id}`, { restaurantId: restaurant.id, quantity });
    const cart = await customer.call<CartView>('PUT', '/cart/address', { addressId: address.id });
    // The total of the chosen mode (the robot one is cheaper); null = not deliverable that way
    const expectedTotalMinor = options.mode === 'robot' ? cart.robotTotalMinor : cart.totalMinor;
    if (expectedTotalMinor === null) {
        throw new RunFailed(options.mode === 'robot'
            ? 'the cart has no robot total (robots off: not a Stripe test key?)'
            : 'the cart has no total (delivery fee unknown)');
    }
    step(options.mode === 'robot'
        ? `cart: ${quantity} x ${item.name}, robot total ${expectedTotalMinor} cents (human ${cart.totalMinor}), ${cart.robotDelivery?.vehicle}`
        : `cart: ${quantity} x ${item.name}, total ${expectedTotalMinor} cents`);

    // 4. Human mode: a courier goes online near the restaurant, in the background until we stop it
    const courier = await startCourier(options, restaurant, step);

    try {
        // 5. Checkout
        const order = await customer.call<PlacedOrder>('POST', '/orders', { expectedTotalMinor, deliveryMode: options.mode }, {
            'Idempotency-Key': randomUUID()
        });
        if (order.deliveryMode !== options.mode) throw new RunFailed(`the order has deliveryMode ${order.deliveryMode}`);
        const clientSecret =
            order.clientSecret ?? (await customer.call<{ clientSecret: string }>('GET', `/orders/${order.id}/payment`)).clientSecret;
        step(`order ${order.orderCode} created (pending_payment)`);

        // 6. Pay. In the browser, Stripe.js confirms with the card the customer typed;
        //    here the secret key confirms with Stripe's test card. Everything after it is the real flow.
        const paymentIntentId = clientSecret.split('_secret_')[0];
        await stripe.paymentIntents.confirm(paymentIntentId, { payment_method: 'pm_card_visa' });
        step('paid with the test Visa, waiting for the webhook');

        const readOrder = () => customer.call<OrderView>('GET', `/orders/${order.id}`);
        await waitFor('the webhook (is `stripe listen` running?)', WEBHOOK_WAIT_MS, async () => {
            const now = await readOrder();
            if (now.status === 'pending_payment') return undefined;
            if (now.status !== 'placed') throw new RunFailed(`expected placed, got ${now.status}`);
            return now;
        });
        step('placed (webhook arrived)');

        // 7. The restaurant accepts and has the food ready at once
        await owner.call('POST', `/owner/orders/${order.id}/accept`, { prepMinutes: 10 });
        step('restaurant accepted');
        await owner.call('POST', `/owner/orders/${order.id}/ready`);
        step('food ready, dispatch starts');

        // 8. Watch the order as the customer sees it. Any courier may deliver it, not only ours.
        let lastStatus = '';
        let courierSeen = false;
        await waitFor(options.mode === 'robot' ? 'the delivery (are the worker and `npm run robots` running?)' : 'the delivery',
            DELIVERY_WAIT_MS, async () => {
            const why = courier.stopped();
            if (why) throw new RunFailed(why);
            const now = await readOrder();
            if (!ON_THE_WAY.includes(now.status)) throw new RunFailed(`the order ended as ${now.status} (${now.cancelReason})`);
            if (now.status !== lastStatus) step(`order is ${now.status}`);
            lastStatus = now.status;

            // Who delivers, as the customer's tracking shows it: a robot for a robot order, a human otherwise
            if (!courierSeen && now.status !== 'delivered') {
                const tracking = await customer.call<OrderTracking>('GET', `/orders/${order.id}/tracking`);
                if (tracking.courier) {
                    courierSeen = true;
                    if (tracking.courier.isRobot !== (options.mode === 'robot')) {
                        throw new RunFailed(`a ${tracking.courier.isRobot ? 'robot' : 'human'} took a ${options.mode} order`);
                    }
                    step(`courier: ${tracking.courier.firstName} (${tracking.courier.vehicleType}${tracking.courier.isRobot ? ', robot' : ''})`);
                }
            }
            return now.status === 'delivered' ? now : undefined;
        });

        // 9. Capture happens after the commit, through the outbox and Stripe
        await waitFor('the payment capture', CAPTURE_WAIT_MS, async () => {
            const now = await readOrder();
            if (now.paymentStatus === 'capture_failed') throw new RunFailed('the capture failed (see the incidents)');
            return now.paymentStatus === 'captured' ? now : undefined;
        });
        step('payment captured');
    } finally {
        await courier.stop();
    }
}

async function main(): Promise<void> {
    if (process.env.NODE_ENV === 'production') throw new Error('Refusing to run: NODE_ENV=production');

    const { values } = parseArgs({
        options: {
            api: { type: 'string', default: 'http://localhost:3000' },
            owner: { type: 'string', default: `maria@${DOMAIN}` },
            courier: { type: 'string', default: `courier1@${DOMAIN}` },
            speedup: { type: 'string', default: '20' },
            runs: { type: 'string', default: '1' },
            mode: { type: 'string', default: 'human' }
        }
    });
    const mode = (['human', 'robot'] as const).find((m) => m === values.mode);
    if (!mode) throw new Error('--mode must be human or robot');

    // The activation step writes to the local database, so the API must be the local one too
    const { hostname } = new URL(values.api);
    if (hostname !== 'localhost' && hostname !== '127.0.0.1') throw new Error('--api must be a local address');

    const runs = Number(values.runs);
    const speedup = Number(values.speedup);
    if (!Number.isInteger(runs) || runs < 1 || !(speedup > 0)) throw new Error('Bad arguments, see the top of scripts/happyPath.ts');

    let passed = 0;
    for (let run = 1; run <= runs; run++) {
        console.log(`Run ${run}/${runs}`);
        const started = Date.now();
        try {
            await happyPath({ apiUrl: values.api, ownerEmail: values.owner, courierEmail: values.courier, speedup, mode });
            passed++;
            console.log(`  PASSED in ${Math.round((Date.now() - started) / 1000)} s\n`);
        } catch (err) {
            console.error(`  FAILED: ${describe(err)}\n`);
            break; // "N in a row": the first failure ends it
        }
    }
    console.log(`${passed}/${runs} passed`);
    if (passed < runs) process.exitCode = 1;
}

main()
    .catch((err: unknown) => {
        console.error(describe(err));
        process.exitCode = 1;
    })
    .finally(() => pool.end());
