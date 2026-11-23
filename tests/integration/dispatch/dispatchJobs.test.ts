import { setTimeout as sleep } from 'node:timers/promises';
import { mockRoute } from '../../helpers/customer';
import { startJob, type Job } from '../../../src/jobs/jobRunner';
import { JOBS } from '../../../src/jobs/jobList';
import { createCourier, readyOrder, pendingOfferOf, offersOf, passOfferDeadline } from '../../helpers/dispatch';

// Boot check: the 'dispatch' job the worker starts (jobList.ts) really dispatches orders and expires offers.
// Real timers: the job's first pass runs at once, the next ones every 2 s.

let job: Job | undefined;

beforeEach(() => {
    mockRoute(3001);
});

afterEach(async () => {
    await job?.stop(); // no pass may still run when the next test resets the database
    job = undefined;
});

function startDispatchJob(): Job {
    const definition = JOBS.find((j) => j.name === 'dispatch');
    if (!definition) throw new Error('no dispatch job in JOBS');
    job = startJob(definition);
    return job;
}

// Waits (for real) until `check` is true, at most 5 s.
async function eventually(check: () => Promise<boolean>): Promise<void> {
    for (let i = 0; i < 100; i++) {
        if (await check()) return;
        await sleep(50);
    }
    throw new Error('condition not reached within 5 s');
}

describe("the worker's dispatch job", () => {
    it('the first pass runs at once and offers the ready order', async () => {
        const courier = await createCourier();
        const { orderId } = await readyOrder();

        startDispatchJob();

        await eventually(async () => (await pendingOfferOf(courier.id))?.order_id === orderId);
    });

    it('a later pass expires the unanswered offer (offer expiry runs before dispatch)', async () => {
        const courier = await createCourier();
        await readyOrder();
        startDispatchJob();
        await eventually(async () => (await pendingOfferOf(courier.id)) !== undefined);

        await passOfferDeadline((await pendingOfferOf(courier.id))!.id);

        await eventually(async () => (await offersOf(courier.id))[0]?.status === 'expired');
    });
});
