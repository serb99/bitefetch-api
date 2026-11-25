import type { PoolClient } from 'pg';
import { AppError } from '../errors/AppError';

// Same values as the order_status enum in the database
type OrderStatus =  | 'pending_payment'
    | 'placed'
    | 'accepted'
    | 'ready_for_pickup'
    | 'picked_up'
    | 'delivered'
    | 'cancelled'
    | 'rejected'
    | 'expired';
type DispatchState = 'not_started' | 'searching' | 'no_courier' | 'assigned';
// A customer sees only their own orders, an owner only their restaurant's. The admin any order.
type OrderScope = { customerId: string } | { restaurantId: string } | { courierId: string } | { anyOrder: true };
type LockedOrder = {
    id: string;
    status: OrderStatus;
    version: number;
    customerId: string;
    restaurantId: string;
    courierId: string | null;
    paymentIntentId: string | null;
    cancelledBy: string | null;
    cancelReason: string | null;
    acceptDeadline: Date | null;
    dispatchState: DispatchState;
};

function scopeCondition(scope: OrderScope): [condition: string, params: string[]] {
    if ('anyOrder' in scope) return ['TRUE', []];
    if ('customerId' in scope) return ['customer_id = $2', [scope.customerId]];
    if ('restaurantId' in scope) return ['restaurant_id = $2', [scope.restaurantId]];
    return [
        `(courier_id = $2 OR EXISTS (
              SELECT 1 FROM order_offers f
               WHERE f.order_id = orders.id
                 AND f.courier_id = $2
                 AND f.status IN ('accepted', 'withdrawn')))`,
        [scope.courierId]
    ];
}

async function lockOrder(client: PoolClient, orderId: string, scope: OrderScope): Promise<LockedOrder>{
    const [condition, scopeParams] = scopeCondition(scope);

    const { rows } = await client.query<LockedOrder>(
        `SELECT id,
                status,
                version,
                customer_id AS "customerId",
                restaurant_id AS "restaurantId",
                courier_id AS "courierId",
                stripe_payment_intent_id AS "paymentIntentId",
                cancelled_by AS "cancelledBy",
                cancel_reason AS "cancelReason",
                accept_deadline AS "acceptDeadline",
                dispatch_state AS "dispatchState"
            FROM orders
          WHERE id = $1 AND ${condition}
          FOR UPDATE`,
          [orderId, ...scopeParams]
    );
    const order = rows[0];
    if (!order) {
        throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }
    return order;
}

function assertStatus(
    order: LockedOrder,
    allowed: readonly OrderStatus[],
    code = 'ORDER_STATUS_CHANGED',
    message = 'The order changed in the meantime'
): void {
     if (!allowed.includes(order.status)) {
        throw new AppError(409, code, message, { status: order.status });
    }
}

function assertAssignedCourier(order: LockedOrder, courierId: string): void {
    if (order.courierId !== courierId) {
        throw new AppError(409, 'ORDER_STATUS_CHANGED', 'You are no longer on this order', { status: order.status });
    }
}

// The admin acts on a page read earlier: the order must still be the version they saw.
function assertVersion(order: LockedOrder, seenVersion: number): void {
    if (order.version !== seenVersion) {
        throw new AppError(409, 'VERSION_CONFLICT', 'The order changed since you loaded it', {
            status: order.status,
            version: order.version
        });
    }
}

const ACTIVE_STATUSES: readonly OrderStatus[] = ['pending_payment', 'placed', 'accepted', 'ready_for_pickup', 'picked_up'];

export { lockOrder, assertStatus, assertAssignedCourier, assertVersion, ACTIVE_STATUSES };
export type { OrderStatus, OrderScope, LockedOrder, DispatchState };
