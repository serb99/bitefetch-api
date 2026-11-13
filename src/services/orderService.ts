import { pool } from '../database/pool';
import { AppError } from '../errors/AppError';

type OrderItemView = {
    menuItemId: string | null;     // null if the menu item was ever hard-deleted
    name: string;
    unitPriceMinor: number;
    quantity: number;
    lineTotalMinor: number;
};

type DeliveryAddressSnapshot = {
    label: string | null;
    street: string;
    details: string | null;
    city: string;
    lat: number;
    lng: number;
};

type OrderView = {
    id: string;
    orderCode: string;
    status: string;
    paymentStatus: string;
    restaurant: { id: string; name: string };
    items: OrderItemView[];
    subtotalMinor: number;
    deliveryFeeMinor: number;
    totalMinor: number;
    currency: string;
    deliveryDistanceM: number;
    deliveryAddress: DeliveryAddressSnapshot;
    paymentExpiresAt: Date;
    createdAt: Date;
};

type OrderRow = Omit<OrderView, 'restaurant' | 'items'> & {
    restaurantId: string;
    restaurantName: string;
};

type OrderSummary = {
    id: string;
    orderCode: string;
    status: string;
    totalMinor: number;
    currency: string;
    createdAt: string;
    restaurantName: string;
    itemCount: number;
};

async function getCustomerOrder(customerId: string, orderId: string): Promise<OrderView> {
    const orderResult = await pool.query<OrderRow> (
        `SELECT o.id,
                o.order_code AS "orderCode",
                o.status,
                o.payment_status AS "paymentStatus",
                o.restaurant_id AS "restaurantId",
                r.name AS "restaurantName",
                o.subtotal_minor AS "subtotalMinor",
                o.delivery_fee_minor AS "deliveryFeeMinor",
                o.total_minor AS "totalMinor",
                o.currency,
                o.delivery_distance_m AS "deliveryDistanceM",
                o.delivery_address_snapshot AS "deliveryAddress",
                o.payment_expires_at AS "paymentExpiresAt",
                o.created_at AS "createdAt"
            FROM orders o
            JOIN restaurants r ON r.id = o.restaurant_id
           WHERE o.id = $1 AND o.customer_id = $2`,
           [orderId, customerId]
    );
    const row = orderResult.rows[0];
    if (!row) {
        throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }

    const itemsResult = await pool.query<OrderItemView>(
        `SELECT menu_item_id AS "menuItemId",
                name,
                unit_price_minor AS "unitPriceMinor",
                quantity,
                line_total_minor AS "lineTotalMinor"
           FROM order_items
          WHERE order_id = $1
          ORDER BY id`,
          [orderId]
    );

    const { restaurantId, restaurantName, ...order } = row;
    return {
        ...order,
        restaurant: { id: restaurantId, name: restaurantName },
        items: itemsResult.rows
    };
}

async function listCustomerOrders(customerId: string, limit: number, before?: string): Promise<OrderSummary[]> {
     const { rows } = await pool.query<OrderSummary>(
        `SELECT o.id,
                o.order_code AS "orderCode",
                o.status,
                o.total_minor AS "totalMinor",
                o.currency,
                o.created_at AS "createdAt",
                r.name AS "restaurantName",
                (SELECT count(*)::int FROM order_items oi WHERE oi.order_id = o.id) AS "itemCount"
         FROM orders o
         JOIN restaurants r ON r.id = o.restaurant_id
         WHERE o.customer_id = $1
           AND ($2::bigint IS NULL OR o.id < $2::bigint)
         ORDER BY o.id DESC
         LIMIT $3`,
         [customerId, before ?? null, limit],
     );
     return rows;
}

export { getCustomerOrder, listCustomerOrders };
export type { OrderView, OrderItemView };