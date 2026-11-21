import { withTransaction } from '../database/transaction';
import { queuePaymentVoid } from './outbox';
import { getCustomerOrder, type OrderView } from './orderService';
import { restoreCartFromOrder } from './cartService';
import { lockOrder, assertStatus } from './orderTransition';

// The customer cancels their own order.
// pending_payment → cancelled: left checkout; the cart comes back so they can try again.
// placed → cancelled: paid but changed their mind before the restaurant accepted; the hold is released.
// From accepted on, only support can cancel
async function cancelCustomerOrder(customerId: string, orderId: string): Promise<OrderView> {
    await withTransaction(async (client) => {
        const order = await lockOrder(client, orderId, { customerId });

        if (order.status === 'cancelled' && order.cancelledBy === 'customer') {
            return;
        }
        assertStatus(order, ['pending_payment', 'placed'], 'ORDER_NOT_CANCELLABLE', 'This order can no longer be cancelled');

        const wasPlaced = order.status === 'placed';
        await client.query(
            `UPDATE orders
                SET status = 'cancelled',
                    cancelled_by = 'customer',
                    cancel_reason = $2,
                    ended_at = now(),
                    version = version + 1
              WHERE id = $1`,
            [order.id, wasPlaced ? 'customer_cancelled' : 'abandoned_checkout']
        );
        
        // No PaymentIntent (Stripe was down at checkout): nothing on the card, nothing to void.
        if (order.paymentIntentId) {
            await queuePaymentVoid(client, order.id, order.paymentIntentId);
        }
        if (!wasPlaced) {
            await restoreCartFromOrder(client, customerId, order.id, order.restaurantId);
        }
    }, `user:${customerId}`, 'cancelled by the customer');

    return getCustomerOrder(customerId, orderId);
}

export { cancelCustomerOrder };