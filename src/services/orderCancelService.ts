import { withTransaction } from '../database/transaction';
import { AppError } from '../errors/AppError';
import { getCustomerOrder, type OrderView } from './orderService';
import { restoreCartFromOrder } from './cartService';
import { lockOrder, type LockedOrder } from './orderTransition';
import { cancelLockedOrder } from './orderCancellation';
import { dispatchWaitingOrdersNear } from './dispatchService';

function notCancellable(order: LockedOrder, message = 'This order can no longer be cancelled'): AppError {
    return new AppError(409, 'ORDER_NOT_CANCELLABLE', message, {
        status: order.status,
        dispatchState: order.dispatchState
    });
}

// Which customer cancel applies now, or why none does.
// pending_payment: left checkout; the cart comes back so they can try again.
// placed: paid but changed their mind before the restaurant accepted; the hold is released.
// accepted / ready_for_pickup: only while no courier was found (dispatch_state no_courier, nobody assigned).
// Anything else (the kitchen is cooking with a courier coming, or the food left): only support can cancel.
function customerCancelReason(order: LockedOrder): 'abandoned_checkout' | 'customer_cancelled' | 'no_courier' {
    if (order.status === 'pending_payment') return 'abandoned_checkout';
    if (order.status === 'placed') return 'customer_cancelled';

    if (order.status === 'accepted' || order.status === 'ready_for_pickup') {
        if (order.dispatchState === 'no_courier' && order.courierId === null) return 'no_courier';
        if (order.dispatchState === 'assigned') {
            throw notCancellable(order, 'A courier just accepted this order');
        }
    }
    throw notCancellable(order);
}

async function cancelCustomerOrder(customerId: string, orderId: string, note?: string): Promise<OrderView> {
    const freedCourierId = await withTransaction(async (client) => {
        const order = await lockOrder(client, orderId, { customerId });

        // Double tap: already cancelled by this customer
        if (order.status === 'cancelled' && order.cancelledBy === 'customer') {
            return null;
        }
        const reason = customerCancelReason(order);

        const { freedCourierId } = await cancelLockedOrder(client, order, { cancelledBy: 'customer', reason, note });

        if (reason === 'abandoned_checkout') {
            await restoreCartFromOrder(client, customerId, order.id, order.restaurantId);
        }
        return freedCourierId;
    }, `user:${customerId}`, 'cancelled by the customer');

    // No courier is assigned in the no_courier case, but keep the rule of every cancel: a freed courier is offered work.
    if (freedCourierId) {
        await dispatchWaitingOrdersNear(freedCourierId);
    }
    return getCustomerOrder(customerId, orderId);
}

export { cancelCustomerOrder };
