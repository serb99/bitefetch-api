import { logger } from '../logger';

// A job does one pass and says how many items it handled (orders expired, offers sent...).
type JobPass = () => Promise<number>;

interface JobOptions {
    name: string;
    everyMs: number; // the pause between the END of a pass and the start of the next one
    run: JobPass;
}

interface JobStats {
    name: string;
    everyMs: number;
    passes: number;
    failures: number;
    lastStartedAt: Date | null;
    lastFinishedAt: Date | null;
    lastDurationMs: number | null;
    lastHandled: number | null;
    lastError: string | null;
}

interface Job {
    stats: Readonly<JobStats>;
    stop(): Promise<void>; //resolves when the pass in progress (if any) has finished
}

function startJob({ name, everyMs, run }: JobOptions): Job {
    const stats: JobStats = {
        name,
        everyMs,
        passes: 0,
        failures: 0,
        lastStartedAt: null,
        lastFinishedAt: null,
        lastDurationMs: null,
        lastHandled: null,
        lastError: null
    };
    let stopped = false;
    let timer: NodeJS.Timeout | undefined;
    let current: Promise<void> | null = null; // the pass running right now

    async function pass(): Promise<void> {
        const startedAt = Date.now();
        stats.lastStartedAt = new Date(startedAt);
        try {
            const handled = await run();
            stats.lastHandled = handled;
            stats.lastError = null;
            if (handled > 0) {
                logger.debug({ job: name, handled }, 'Job pass');
            }
        } catch (err) {
            stats.failures++;
            stats.lastError = err instanceof Error ? err.message : String(err);
            logger.error({ err, job: name }, 'Job pass failed');
        } finally {
            stats.passes++;
            stats.lastFinishedAt = new Date();
            stats.lastDurationMs = Date.now() - startedAt;
        }
    }

    function schedule(delayMs: number): void {
        if (stopped) return;
        timer = setTimeout(() => {
            current = pass().finally(() => {
                current = null;
                schedule(everyMs); // the next pass is planned only when this one is over
            })
        }, delayMs);
    }

    schedule(0);
    logger.info({ job: name, everyMs }, 'Job started');

    return {
        stats,
        async stop() {
            stopped = true;
            clearTimeout(timer);
            if (current) {
                await current;
            }
        }
    }
}

export { startJob };
export type { Job, JobStats, JobPass };