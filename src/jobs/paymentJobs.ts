import { logger } from '../logger';
import { processPaymentOutbox } from '../services/paymentOutbox';
import { expirePendingPayments } from '../services/paymentExpiry';

const TICK_MS = 5_000;

// Payment background work
// Started from server.ts only: the tests import app.ts, so no timer runs during tests.
function startPaymentJobs(): void {
    let running = false;

    setInterval(async () => {
        // The previous tick is still busy (slow Stripe): skip this one instead of running two at once.
        if (running) return;
        running = true;
        try {
            const expired = await expirePendingPayments();
            const done = await processPaymentOutbox();
            if (expired > 0 || done > 0) {
                logger.info({ expired, done }, 'Payment jobs pass');
            }
        } catch (err) {
            logger.error({ err }, 'Payment jobs tick failed');
        } finally {
            running = false;
        }
    }, TICK_MS);

    logger.info({ everyMs: TICK_MS }, 'Payment jobs started');
}

export { startPaymentJobs };