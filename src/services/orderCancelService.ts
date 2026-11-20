import { withTransaction } from '../database/transaction';
import { AppError } from '../errors/AppError';
import { queuePaymentVoid } from './outbox';
import { getCustomerOrder, type OrderView } from './orderService';
import { restoreCartFromOrder } from './cartService';

type CancelOrderRow = {
    id: string;
    status: string;
    cancelReason: string | null;
    restaurantId: string;
    paymentIntentId: string | null;
}

// the customer leaves checkout. pending_payment → cancelled, void queued, cart given back.
async function cancelPendingOrder(customerId: string, orderId: string): Promise<OrderView> {
    await withTransaction(async (client) => {
        const { rows } = await client.query<CancelOrderRow>(
            `SELECT id,
                    status,
                    cancel_reason AS "cancelReason",
                    restaurant_id AS "restaurantId",
                    stripe_payment_intent_id AS "paymentIntentId"
               FROM orders
              WHERE id = $1 AND customer_id = $2
              FOR UPDATE`,
              [orderId, customerId]
        );
        const order = rows[0];
        if (!order) {
            throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
        }
        if (order.status === 'cancelled' && order.cancelReason === 'abandoned_checkout') {
            return ;
        }
        if (order.status !== 'pending_payment') {
            throw new AppError(409, 'ORDER_NOT_CANCELLABLE', 'This order can no longer be cancelled', { status: order.status });
        }

         await client.query(
            `UPDATE orders
                SET status = 'cancelled',
                    cancelled_by = 'customer',
                    cancel_reason = 'abandoned_checkout',
                    ended_at = now(),
                    version = version + 1
              WHERE id = $1`,
              [order.id]
         );

         // No PaymentIntent (Stripe was down at checkout) - nothing is held on the card, nothing to void
         if (order.paymentIntentId){
            await queuePaymentVoid(client, order.id, order.paymentIntentId);
         }
         await restoreCartFromOrder(client, customerId, order.id, order.restaurantId);
    }, `user:${customerId}`, 'cancel order (abandoned checkout)');

    return getCustomerOrder(customerId, orderId);
}

export { cancelPendingOrder };