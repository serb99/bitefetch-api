import 'dotenv/config';
import { pool } from './database/pool';
import { logger } from './logger';
import { startJob, type Job } from './jobs/jobRunner';
import { JOBS } from './jobs/jobList';

const HEALTH_EVERY_MS = 60_000;
const SHUTDOWN_TIMEOUT_MS = 10_000;
// A job counts as stuck when it has not finished a pass for this many of its intervals
const STUCK_AFTER_INTERVALS = 5;

const startedAt = Date.now();
let jobs: Job[] = [];
let healthTimer: NodeJS.Timeout | undefined;
let shuttingDown = false;

function logHealth(): void {
    const now = Date.now();
    for (const { stats } of jobs) {
        const lastActivity = stats.lastFinishedAt?.getTime() ?? startedAt;
        const silentMs = now - lastActivity;
        if (silentMs > Math.max(STUCK_AFTER_INTERVALS * stats.everyMs, 60_000)) {
            logger.warn({ job: stats.name, silentMs, lastStartedAt: stats.lastStartedAt }, 'Job looks stuck');
        }
    }
    logger.info(
        {
            uptimeS: Math.round((now - startedAt) / 1000),
            jobs: jobs.map(({ stats }) => ({
                name: stats.name,
                passes: stats.passes,
                failures: stats.failures,
                lastHandled: stats.lastHandled,
                lastDurationMs: stats.lastDurationMs,
                lastError: stats.lastError,
            })),
        },
        'Worker health'
    );
}

async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return; // a second Ctrl+C while stopping changes nothing
    shuttingDown = true;
    logger.info({ signal }, 'Worker stopping: waiting for running passes');
    clearInterval(healthTimer);

    const allStopped = Promise.all(jobs.map((job) => job.stop())).then(() => 'stopped' as const);
    const tooSlow = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), SHUTDOWN_TIMEOUT_MS).unref();
    });

    if ((await Promise.race([allStopped, tooSlow])) === 'timeout') {
        // Safe to leave: an unfinished transaction is rolled back by Postgres, and a leased outbox row
        // is picked up again after its lease by the next worker
        logger.warn({ afterMs: SHUTDOWN_TIMEOUT_MS }, 'Passes still running, exiting anyway');
        process.exit(1);
    }

    await pool.end();
    logger.info('Worker stopped');
    process.exit(0);
}

async function main(): Promise<void> {
    // Fail fast with a clear message instead of every job failing every few seconds
    await pool.query('SELECT 1');

    jobs = JOBS.map((definition) => startJob(definition));
    healthTimer = setInterval(logHealth, HEALTH_EVERY_MS);

    process.on('SIGINT', () => void shutdown('SIGINT')); // Ctrl+C
    process.on('SIGTERM', () => void shutdown('SIGTERM')); // docker stop, kill
    logger.info({ jobs: JOBS.map((job) => `${job.name} every ${job.everyMs} ms`) }, 'Worker started');
}

main().catch((err) => {
    logger.fatal({ err }, 'Worker could not start');
    process.exit(1);
});