import type { JobPass } from './jobRunner';
import { expirePendingPayments } from '../services/paymentExpiry';
import { rejectTimedOutOrders } from '../services/acceptTimeout';
import { processPaymentOutbox } from '../services/paymentOutbox';
import { expireTimedOutOffers } from '../services/offerTimeout';
import { dispatchDueOrders, markNoCourierOrders } from '../services/dispatchService';
import { sweepLateOrders } from '../services/incidentSweeps';
import { reconcilePendingPayments } from '../services/paymentReconciliation';
import { setSilentCouriersOffline } from '../services/courierAutoOffline';
import { runRetention } from '../services/retention';
import { startRobotsForDueOrders, setIdleRobotsOffline } from '../services/robotDispatch';

interface JobDefinition {
    name: string;
    everyMs: number;
    run: JobPass;
}

// Every time-based job of the system. Started only by src/worker.ts (never by the API or the tests).
const JOBS: JobDefinition[] = [
    { name: 'payment-expiry', everyMs: 5_000, run: expirePendingPayments },
    { name: 'accept-timeout', everyMs: 5_000, run: rejectTimedOutOrders },
    { name: 'payment-outbox', everyMs: 5_000, run: processPaymentOutbox }, 
    { 
        name: 'dispatch', 
        everyMs: 2_000, 
        // expire unanswered offers (+ missed-offer count), mark orders past the search deadline no_courier, then search couriers
        run: async () =>
            (await expireTimedOutOffers()) + (await markNoCourierOrders()) + (await dispatchDueOrders())
    },
    // M9b: start a robot for robot orders being searched (then offers it at once), and park idle robots
    { name: 'robot-start', everyMs: 2_000, run: startRobotsForDueOrders },
    { name: 'robot-idle', everyMs: 30_000, run: setIdleRobotsOffline },
    { name: 'payment-reconciliation', everyMs: 60_000, run: reconcilePendingPayments },
    { name: 'courier-auto-offline', everyMs: 15_000, run: setSilentCouriersOffline },
    // kitchen_late and delivery_overdue incidents
    { name: 'incident-sweep', everyMs: 30_000, run: sweepLateOrders },
    { name: 'retention', everyMs: 60 * 60_000, run: runRetention }
];

export { JOBS };
export type { JobDefinition };