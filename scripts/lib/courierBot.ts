import { setTimeout as sleep } from 'node:timers/promises';
import type { CourierState } from '../../src/services/courierService';
import type { CurrentOffer, AcceptResult } from '../../src/services/courierOfferService';
import type { CourierOrder, PickedUpOrder } from '../../src/services/courierOrderService';
import type { Route } from '../../src/services/osrmClient';
import { ApiClient, ApiCallError } from './apiClient';
import { decodePolyline, moveAlong, type LatLng } from './movement';

type Answer = 'accept' | 'decline' | 'ignore';

type BotOptions = {
    api: ApiClient;
    start: LatLng;
    speedup: number;                 // 10 = ten times faster than the real vehicle
    answer: Answer;
    signal: AbortSignal;             // abort = stop and go offline
    log: (message: string) => void;
    stopAfterDeliveries?: number;
    onDelivered?: () => void;        // the fleet uses it to stop everyone after the first delivery
    tickMs?: number;
    // M9b robots: the WORKER put this courier online (with a position at the restaurant). The bot does not go
    // online itself, does one job and stops (then goes offline) as soon as it has no order and no offer:
    // after the delivery, or when the order was cancelled.
    managed?: boolean;
};

// robot: about 6 km/h on the sidewalk; robot_car: a car that drives 25% slower (30 / 1.25)
const SPEED_KMH = { bike: 15, scooter: 25, car: 30, robot: 6, robot_car: 24 } as const;

async function runCourierBot(options: BotOptions): Promise<number> {
    const { api, speedup, answer, signal, log } = options;
    const tickMs = options.tickMs ?? 3_000;

    let position = options.start;
    let path: LatLng[] = [];
    let heading: string | null = null;
    let delivered = 0;
    let lastMessage = '';
    let jobDone = false;   // managed: nothing left to do, stop

    function say(message: string): void {
        if (message !== lastMessage) {
            log(message);
        }
        lastMessage = message;
    }

    function sendPosition(): Promise<void> {
        return api.call('PUT', '/courier/position', { ...position, recordedAt: new Date().toISOString() });
    }

    function headTo(key: string, target: LatLng, route: Route | null): void {
        heading = key;
        // Only lat/lng: the target may be a whole restaurant or customer object, and the last
        // path point becomes the position we send (PUT /courier/position has a strict body)
        path = [...(route ? decodePolyline(route.polyline) : []), { lat: target.lat, lng: target.lng }];
    }

    // false: there was no offer
    async function answerOffer(): Promise<boolean> {
        const { offer } = await api.call<{ offer: CurrentOffer | null }>('GET', '/courier/offers/current');
        if (!offer) {
            say('waiting for an offer');
            return false;
        }
        say(`offer ${offer.id}: ${offer.restaurant.name}, ${offer.distanceToRestaurantM} m away`);
        if (answer === 'ignore') return true;
        if (answer === 'decline') {
            await api.call('POST', `/courier/offers/${offer.id}/decline`, { reason: 'busy' });
            say(`declined offer ${offer.id}`);
            return true;
        }

        const { order, route, orderCode } = await api.call<AcceptResult>('POST', `/courier/offers/${offer.id}/accept`);
        say(`accepted ${orderCode}, ${route ? 'following the road' : 'no route, straight line'}`);
        if (order) headTo(`${order.id}:restaurant`, order.restaurant, route);
        return true;
    }

    async function workOn(order: CourierOrder): Promise<void> {
        const toCustomer = order.status === 'picked_up';
        const key = `${order.id}:${toCustomer ? 'customer' : 'restaurant'}`;
        const target = toCustomer ? order.customer : order.restaurant;

        // After a restart, or when a response was lost
        if (heading !== key) headTo(key, { lat: target.lat, lng: target.lng }, null);

        if (path.length > 0) {
            say(`${order.orderCode}: driving to the ${toCustomer ? 'customer' : 'restaurant'}`);
            return;
        }
        if (toCustomer) {
            await api.call('POST', `/courier/orders/${order.id}/deliver`);
            delivered++;
            heading = null;
            say(`${order.orderCode}: delivered`);
            options.onDelivered?.();
        } else if (order.status === 'accepted') {
            say(`${order.orderCode}: at the counter, the food is not ready`);
        } else {
            const { route } = await api.call<PickedUpOrder & { route: Route | null }>('POST', `/courier/orders/${order.id}/pickup`);
            say(`${order.orderCode}: picked up`);
            headTo(`${order.id}:customer`, order.customer, route);
        }
    }

    async function tick(metersPerTick: number): Promise<void> {
        ({ position, remaining: path } = moveAlong(position, path, metersPerTick));
        // Position first: pickup and deliver check the stored one
        await sendPosition();

        const { order } = await api.call<{ order: CourierOrder | null }>('GET', '/courier/orders/current');
        if (order) {
            await workOn(order);
            return;
        }
        if (heading) {
            say('the order is gone (cancelled or finished)');
            heading = null;
            path = [];
        }
        const hadOffer = await answerOffer();
        // A robot never waits for the next job: the worker starts a robot per order
        if (options.managed && !hadOffer) jobDone = true;
    }

    await api.login();
    await sendPosition();
    // managed: already online (the worker did it); only read the vehicle
    const { vehicleType } = options.managed
        ? await api.call<CourierState>('GET', '/courier')
        : await api.call<CourierState>('POST', '/courier/availability', { online: true });
    const metersPerTick = ((SPEED_KMH[vehicleType] * 1000) / 3600) * (tickMs / 1000) * speedup;
    log(`online (${vehicleType}, ${Math.round(metersPerTick)} m per step)`);

    try {
        while (!signal.aborted) {
            try {
                await tick(metersPerTick);
            } catch (err) {
                // Like a real phone: say it and try again at the next tick
                if (err instanceof ApiCallError) {
                    say(`${err.status} ${err.code} ${JSON.stringify(err.details)}`);
                } else {
                    say(`request failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            if (options.stopAfterDeliveries && delivered >= options.stopAfterDeliveries) break;
            if (jobDone) break;
            await sleep(tickMs, undefined, { signal }).catch(() => undefined); // abort wakes it up
        }
    } finally {
        await api.call('POST', '/courier/availability', { online: false }).then(
            () => log('offline'),
            () => log('could not go offline')
        );
    }
    return delivered;
}

export { runCourierBot };
export type { Answer, BotOptions };