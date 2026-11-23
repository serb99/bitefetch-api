import { startJob, type Job } from '../../src/jobs/jobRunner';

// M8 job runner: a setTimeout chain. First pass at once, the next one `everyMs` after the previous one ENDED,
// never two passes of the same job at once, a failed pass never stops the job, stop() waits for a running pass.
// Fake timers (Date included), so "a pass that takes 3 s" takes 3 fake seconds.

let job: Job | undefined;

beforeEach(() => {
    jest.useFakeTimers();
});

afterEach(async () => {
    // stop() waits for a running pass, and a slow pass only ends when fake time moves on: let it move
    const stopping = job?.stop();
    await jest.advanceTimersByTimeAsync(10_000);
    await stopping;
    job = undefined;
    jest.useRealTimers();
});

// A pass that takes `ms` (fake) milliseconds and reports `handled` items.
function slowPass(ms: number, handled = 0) {
    return () => new Promise<number>((resolve) => setTimeout(() => resolve(handled), ms));
}

describe('scheduling', () => {
    it('the first pass starts at once, the next ones everyMs after the previous pass ended', async () => {
        const run = jest.fn().mockResolvedValue(0);
        job = startJob({ name: 'test', everyMs: 2_000, run });

        expect(run).not.toHaveBeenCalled(); // planned with setTimeout(0), not called inside startJob
        await jest.advanceTimersByTimeAsync(0);
        expect(run).toHaveBeenCalledTimes(1);

        await jest.advanceTimersByTimeAsync(1_999);
        expect(run).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(run).toHaveBeenCalledTimes(2);

        await jest.advanceTimersByTimeAsync(4_000);
        expect(run).toHaveBeenCalledTimes(4);
    });

    it('a pass of 3 s with everyMs 2 s: the next pass starts at 5 s, two passes never overlap', async () => {
        let running = 0;
        let maxRunning = 0;
        const pass = slowPass(3_000);
        const run = jest.fn(async () => {
            running++;
            maxRunning = Math.max(maxRunning, running);
            try {
                return await pass();
            } finally {
                running--;
            }
        });
        job = startJob({ name: 'slow', everyMs: 2_000, run });

        await jest.advanceTimersByTimeAsync(0);
        expect(run).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(4_999); // pass 1 ends at 3 s, the next is planned for 5 s
        expect(run).toHaveBeenCalledTimes(1);
        await jest.advanceTimersByTimeAsync(1);
        expect(run).toHaveBeenCalledTimes(2);

        await jest.advanceTimersByTimeAsync(20_000);
        expect(maxRunning).toBe(1);
    });
});

describe('failures and stats', () => {
    it('a pass that throws counts as a failure and the job keeps running', async () => {
        const run = jest.fn()
            .mockRejectedValueOnce(new Error('database restarting'))
            .mockResolvedValue(3);
        job = startJob({ name: 'flaky', everyMs: 1_000, run });

        await jest.advanceTimersByTimeAsync(0);
        expect(job.stats).toMatchObject({ passes: 1, failures: 1, lastError: 'database restarting', lastHandled: null });

        await jest.advanceTimersByTimeAsync(1_000);
        expect(run).toHaveBeenCalledTimes(2);
        expect(job.stats).toMatchObject({ passes: 2, failures: 1, lastError: null, lastHandled: 3 });
    });

    it('stats: passes, lastHandled, lastDurationMs and the start/finish times of the last pass', async () => {
        job = startJob({ name: 'stats', everyMs: 1_000, run: slowPass(250, 7) });

        await jest.advanceTimersByTimeAsync(250);

        expect(job.stats).toMatchObject({
            name: 'stats',
            everyMs: 1_000,
            passes: 1,
            failures: 0,
            lastHandled: 7,
            lastDurationMs: 250,
            lastError: null,
        });
        expect(job.stats.lastFinishedAt!.getTime() - job.stats.lastStartedAt!.getTime()).toBe(250);
    });
});

describe('stop()', () => {
    it('between passes: resolves at once and no pass runs again', async () => {
        const run = jest.fn().mockResolvedValue(0);
        job = startJob({ name: 'idle', everyMs: 2_000, run });
        await jest.advanceTimersByTimeAsync(0);

        await job.stop();
        await jest.advanceTimersByTimeAsync(10_000);

        expect(run).toHaveBeenCalledTimes(1);
    });

    it('during a pass: waits for that pass to finish, and no pass starts afterwards', async () => {
        const run = jest.fn(slowPass(3_000));
        job = startJob({ name: 'busy', everyMs: 1_000, run });
        await jest.advanceTimersByTimeAsync(0); // pass 1 is running

        let stopped = false;
        const stopping = job.stop().then(() => {
            stopped = true;
        });
        await jest.advanceTimersByTimeAsync(2_999);
        expect(stopped).toBe(false);
        await jest.advanceTimersByTimeAsync(1);
        await stopping;
        expect(stopped).toBe(true);
        expect(job.stats.passes).toBe(1);

        await jest.advanceTimersByTimeAsync(10_000);
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('before the first pass: nothing ever runs', async () => {
        const run = jest.fn().mockResolvedValue(0);
        job = startJob({ name: 'never', everyMs: 1_000, run });

        await job.stop();
        await jest.advanceTimersByTimeAsync(5_000);

        expect(run).not.toHaveBeenCalled();
    });
});
