import { logger } from '../logger';
import { expireTimedOutOffers } from '../services/offerTimeout';
import { dispatchDueOrders } from '../services/dispatchService';

const TICK_MS = 2_000;

function startDispatchJobs(): void {
    let running = false;

    setInterval(async () => {
        if (running) return;
        running = true;
        try {
            const expired = await expireTimedOutOffers();
            const handled = await dispatchDueOrders();
            if (expired > 0 || handled > 0) {
                logger.debug({ expired, handled }, 'Dispatch jobs pass');
            }
        } catch (err) {
            logger.error({ err }, 'Dispatch jobs tick failed');
        } finally {
            running = false;
        }
    }, TICK_MS);

    logger.info({ everyMs: TICK_MS }, 'Dispatch jobs started');
}

export { startDispatchJobs };