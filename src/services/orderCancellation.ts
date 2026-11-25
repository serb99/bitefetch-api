import type { PoolClient } from 'pg';
import { queuePaymentVoid } from './outbox';
import { resolveOrderIncidents } from './incidents';
import type { LockedOrder } from './orderTransition';

type CancelledBy = 'customer' | 'restaurant' | 'admin';
type CancelInput = { cancelledBy: CancelledBy; reason: string; note?: string | null };

// One place for "→ cancelled", whoever cancels (customer, restaurant, admin). The caller has locked the order and checked the status.
// In the same transaction:
// - the order row: cancelled, who and why, ended_at. The courier is released (courier_id NULL) unless the food
//   was already picked up (an admin cancel after pickup: the row keeps who had it).
// - a courier still deciding on an offer for it: the offer is withdrawn.
// - a pending owner cancellation request is superseded: the order ended another way.
// - the card hold is released by the outbox (void), never charged.
// - every open incident of the order is resolved: the order is over.
// Returns the courier who had the order, so the caller can kick dispatch for them AFTER the commit.
async function cancelLockedOrder(client: PoolClient, order: LockedOrder, input: CancelInput): Promise<{ freedCourierId: string | null }> {
    await client.query(
        `UPDATE orders
            SET status = 'cancelled',
                cancelled_by = $2,
                cancel_reason = $3,
                cancel_note = $4,
                courier_id = CASE WHEN status = 'picked_up' THEN courier_id ELSE NULL END,
                ended_at = now(),
                version = version + 1
          WHERE id = $1`,
        [order.id, input.cancelledBy, input.reason, input.note ?? null]
    );

    await client.query(
        `UPDATE order_offers
            SET status = 'withdrawn',
                responded_at = now()
          WHERE order_id = $1
            AND status = 'pending'`,
        [order.id]
    );

    await client.query(
        `UPDATE order_cancel_requests
            SET status = 'superseded',
                decided_at = now(),
                version = version + 1
          WHERE order_id = $1
            AND status = 'pending'`,
        [order.id]
    );

    // No PaymentIntent (Stripe was down at checkout): nothing on the card, nothing to void.
    if (order.paymentIntentId) {
        await queuePaymentVoid(client, order.id, order.paymentIntentId);
    }

    await resolveOrderIncidents(client, order.id, 'all', `order cancelled by the ${input.cancelledBy}`);

    return { freedCourierId: order.courierId };
}

export { cancelLockedOrder };
export type { CancelInput, CancelledBy };
