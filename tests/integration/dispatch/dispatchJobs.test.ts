import { setTimeout as sleep } from 'node:timers/promises';
import { mockRoute } from '../../helpers/customer';
import { startDispatchJobs } from '../../../src/jobs/dispatchJobs';
import { createCourier, readyOrder, pendingOfferOf, offersOf, passOfferDeadline } from '../../helpers/dispatch';

// Boot check: the 2 s timer that server.ts starts really expires offers and dispatches orders.
// Only setInterval is faked (the database, supertest and sleep keep their real timers); the interval
// startDispatchJobs creates has no handle, so it lives on the fake clock and disappears with useRealTimers().

const FAKE_ONLY_SET_INTERVAL = {
    doNotFake: [
        'Date', 'hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame', 'cancelAnimationFrame',
        'requestIdleCallback', 'cancelIdleCallback', 'setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout',
    ],
} as const;

beforeEach(() => {
    mockRoute(3001);
    jest.useFakeTimers(FAKE_ONLY_SET_INTERVAL as Parameters<typeof jest.useFakeTimers>[0]);
});

afterEach(() => {
    jest.useRealTimers();
});

// Waits (for real) until `check` is true, at most 5 s.
async function eventually(check: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (await check()) return;
        await sleep(50);
    }
    throw new Error('condition not reached within 5 s');
}

describe('startDispatchJobs (the timer in server.ts)', () => {
    it('nothing happens before the first tick; after 2 s the ready order is offered', async () => {
        const courier = await createCourier();
        const { orderId } = await readyOrder();

        startDispatchJobs();
        await sleep(100);
        expect(await pendingOfferOf(courier.id)).toBeUndefined();

        jest.advanceTimersByTime(2_000);
        await eventually(async () => (await pendingOfferOf(courier.id))?.order_id === orderId);
    });

    it('a later tick expires the unanswered offer (expiry runs before dispatch)', async () => {
        const courier = await createCourier();
        await readyOrder();
        startDispatchJobs();
        jest.advanceTimersByTime(2_000);
        await eventually(async () => (await pendingOfferOf(courier.id)) !== undefined);
        await passOfferDeadline((await pendingOfferOf(courier.id))!.id);

        jest.advanceTimersByTime(2_000);

        await eventually(async () => (await offersOf(courier.id))[0]?.status === 'expired');
    });
});
