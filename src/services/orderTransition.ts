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
// A customer sees only their own orders, an owner only their restaurant's.
type OrderScope = { customerId: string } | { restaurantId: string };
type LockedOrder = {
    id: string;
    status: OrderStatus;
    version: number;
    customerId: string;
    restaurantId: string;
    paymentIntentId: string | null;
    cancelledBy: string | null;
    cancelReason: string | null;
    acceptDeadline: Date | null;
};

async function lockOrder(client: PoolClient, orderId: string, scope: OrderScope): Promise<LockedOrder>{
    const [scopeColumn, scopeId] = 'customerId' in scope
        ? ['customer_id', scope.customerId]
        : ['restaurant_id', scope.restaurantId];
    
    const { rows } = await client.query<LockedOrder>(
        `SELECT id,
                status,
                version,
                customer_id AS "customerId",
                restaurant_id AS "restaurantId",
                stripe_payment_intent_id AS "paymentIntentId",
                cancelled_by AS "cancelledBy",
                cancel_reason AS "cancelReason",
                accept_deadline AS "acceptDeadline"
            FROM orders
          WHERE id = $1 AND ${scopeColumn} = $2
          FOR UPDATE`,
          [orderId, scopeId]
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

export { lockOrder, assertStatus };
export type { OrderStatus, OrderScope, LockedOrder };