import { withTransaction } from '../database/transaction';
import { AppError } from '../errors/AppError';
import { getOrCreateCart } from './cartService';
import { isOrderable } from './browseService';
import { quoteDelivery } from './deliveryQuoteService';
import { getNumberSettings } from './settingsService';
import { getCustomerOrder, type OrderView } from './orderService';
import { generateOrderCode } from '../utils/orderCode';
import type { OpeningHours } from '../utils/openingHours';

type CheckoutResult = { order: OrderView; created: boolean };

type LineRow = {
    menuItemId: string;
    name: string;
    unitPriceMinor: number;
    currency: string;
    quantity: number;
    lineTotalMinor: number;
    available: boolean;
};

type RestaurantRow = {
    id: string;
    name: string;
    is_open: boolean;
    paused_until: Date | null;
    opening_hours: OpeningHours | null;
    lat: number;
    lng: number;
};

type AddressRow = {
    id: string;
    label: string | null;
    street: string;
    details: string | null;
    city: string;
    lat: number;
    lng: number;
};

const MAX_CODE_ATTEMPTS = 5;

async function createOrder(
    customerId: string,
    idempotencyKey: string,
    expectedTotalMinor: number
): Promise<CheckoutResult> {
    const outcome = await withTransaction(async (client) => {
        // 1. lock the cart: a second click or a retry waits here until we finish
        const cart = await getOrCreateCart(client, customerId);

        // 2. idempotency: the same key again returns the order that already exists.
        // This must come BEFORE the cart checks, because after a success the cart is empty.
        const existing = await client.query<{ id: string }>(
            `SELECT id FROM orders WHERE customer_id = $1 AND idempotency_key = $2`,
            [customerId, idempotencyKey]
        );
        if (existing.rows[0]) {
            return { orderId: existing.rows[0].id, created: false };
        }

        const linesResult = await client.query<LineRow>(
            `SELECT ci.menu_item_id AS "menuItemId",
                    m.name,
                    m.price_minor AS "unitPriceMinor",
                    m.currency,
                    ci.quantity,
                    m.price_minor * ci.quantity AS "lineTotalMinor",
                    (m.is_active AND COALESCE(a.available, true)) AS available
               FROM cart_items ci
               JOIN menu_items m ON m.id = ci.menu_item_id
               LEFT JOIN restaurant_item_availability a
                      ON a.menu_item_id = m.id AND a.restaurant_id = $2
              WHERE ci.cart_id = $1
              ORDER BY ci.created_at, ci.id`,
            [cart.id, cart.restaurantId]
        );
        const lines = linesResult.rows;

        if (lines.length === 0 || cart.restaurantId === null) {
            throw new AppError(409, 'CART_EMPTY', 'Your cart is empty');
        }
        if (cart.deliveryAddressId === null) {
            throw new AppError(409, 'CART_NO_ADDRESS', 'Choose a delivery address first');
        }

        // 4. the restaurant must still be there and open now
        const restaurantResult = await client.query<RestaurantRow>(
            `SELECT id, name, is_open, paused_until, opening_hours, lat, lng
               FROM restaurants WHERE id = $1 AND owner_id IS NOT NULL`,
            [cart.restaurantId]
        );
        const restaurant = restaurantResult.rows[0];
        if (!restaurant) {
            throw new AppError(409, 'RESTAURANT_UNAVAILABLE', 'This restaurant is not available');
        }
        if (!isOrderable(restaurant, new Date())) {
            throw new AppError(409, 'RESTAURANT_CLOSED', 'This restaurant is closed right now');
        }

        //5. the address must still be the customer's own
        const addressResult = await client.query<AddressRow>(
            `SELECT id, label, street, details, city, lat, lng
              FROM delivery_addresses WHERE id = $1 AND user_id = $2`,
            [cart.deliveryAddressId, customerId]
        );
        const address = addressResult.rows[0];
        if (!address) {
            throw new AppError(409, 'CART_NO_ADDRESS', 'Choose a delivery address first');
        }

        // 6. unavailable items
        const unavailable = lines.filter((line) => !line.available);
        if (unavailable.length > 0) {
            throw new AppError(409, 'ITEM_UNAVAILABLE', 'Some items are not available anymore', {
                items: unavailable.map((line) => ({ menuItemId: line.menuItemId, name: line.name })),
            });
        }

        // 7. minimum order, delivery quote (distance, 7 km limit, fee), and the total
        const settings = await getNumberSettings(['min_order_minor', 'payment_window_s'] as const);
        const subtotalMinor = lines.reduce((sum, line) => sum + line.lineTotalMinor, 0);
        if (subtotalMinor < settings.min_order_minor) {
            throw new AppError(422, 'MIN_ORDER_NOT_MET', 'The order is below the minimum', {
                minOrderMinor: settings.min_order_minor,
                subtotalMinor,
            });
        }

        const quote = await quoteDelivery(
            { lat: restaurant.lat, lng: restaurant.lng },
            { lat: address.lat, lng: address.lng }
        );
        const totalMinor = subtotalMinor + quote.feeMinor;

        // 8. the customer must have seen this total
        if (totalMinor !== expectedTotalMinor) {
            throw new AppError(409, 'PRICE_CHANGED', 'The price changed, please check your order again', {
                subtotalMinor,
                deliveryFeeMinor: quote.feeMinor,
                totalMinor,
            });
        }

        // 9. the order. ON CONFLICT DO NOTHING on the code: a unique violation would abort
        // the whole transaction, so we ask Postgres to skip it and we try a new order code.
        const snapshot = {
            label: address.label,
            street: address.street,
            details: address.details,
            city: address.city,
            lat: address.lat,
            lng: address.lng,
        };

        let orderId: string | null = null;
        for (let attempt = 0; attempt < MAX_CODE_ATTEMPTS && orderId === null; attempt++) {
            const inserted = await client.query<{ id: string }>(
                `INSERT INTO orders (
                    order_code, customer_id, restaurant_id, delivery_address_id, idempotency_key,
                    subtotal_minor, delivery_fee_minor, total_minor, currency, delivery_distance_m,
                    delivery_address_snapshot, delivery_lat, delivery_lng, payment_expires_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13,
                         now() + ($14::int * interval '1 second'))
                ON CONFLICT (order_code) DO NOTHING
                RETURNING id`,
                [
                  generateOrderCode(), customerId, restaurant.id, address.id, idempotencyKey,
                  subtotalMinor, quote.feeMinor, totalMinor, lines[0].currency, quote.distanceM,
                  JSON.stringify(snapshot), address.lat, address.lng, settings.payment_window_s  
                ]
            );
            orderId = inserted.rows[0]?.id ?? null;
        }
        if (orderId === null) {
            throw new Error('Could not generate a unique order code');
        }

        // 10. copy each line: name and price as they are now
        for (const line of lines) {
            await client.query(
                `INSERT INTO order_items (order_id, menu_item_id, name, unit_price_minor, quantity, line_total_minor)
                 VALUES ($1, $2, $3, $4, $5, $6)`,
                 [orderId, line.menuItemId, line.name, line.unitPriceMinor, line.quantity, line.lineTotalMinor]
            );
        }

        // 11. empty the cart (the chosen address stays selected)
        await client.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cart.id]);
        await client.query(`UPDATE carts SET restaurant_id = NULL WHERE id = $1`, [cart.id]);

        return { orderId, created: true };
    }, `user:${customerId}`, 'checkout');

    const order = await getCustomerOrder(customerId, outcome.orderId);
    return { order, created: outcome.created };
}

export { createOrder };
export type { CheckoutResult };