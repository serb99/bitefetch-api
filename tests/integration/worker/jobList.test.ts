import { JOBS } from '../../../src/jobs/jobList';

// M8: the list the worker starts. Names are what the health log shows, so they must be unique.

it('every job of the system is listed once, with a positive interval', () => {
    expect(JOBS.map((job) => job.name).sort()).toEqual([
        'accept-timeout',
        'courier-auto-offline',
        'dispatch',
        'incident-sweep',
        'payment-expiry',
        'payment-outbox',
        'payment-reconciliation',
        'retention',
    ]);
    for (const job of JOBS) {
        expect(job.everyMs).toBeGreaterThan(0);
        expect(typeof job.run).toBe('function');
    }
});
