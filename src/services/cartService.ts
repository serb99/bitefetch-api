import type { PoolClient } from 'pg';
import { pool } from '../database/pool';
import { isOrderable } from './browseService';
import { withTransaction } from '../database/transaction';
import { AppError } from '../errors/AppError';
import type { SetCartItemInput } from '../schemas/cartSchema';
import type { OpeningHours } from '../utils/openingHours';
import { quoteDelivery, type DeliveryQuote } from './deliveryQuoteService';
import { getNumberSettings } from './settingsService';

type CartRow = { id: string; restaurantId: string | null; deliveryAddressId: string | null };

type CartLine = {
    menuItemId: string;
    name: string;
    unitPriceMinor: number;
    currency: string;
    quantity: number;
    lineTotalMinor: number;
    available: boolean;
};

type CartView = {
    restaurant: { id: string; name: string; orderable: boolean } | null;
    address: { id: string; label: string | null; street: string; city: string } | null;
    items: CartLine[];
    subtotalMinor: number;
    currency: string;
    minOrderMinor: number;
    meetsMinOrder: boolean;
    delivery: DeliveryQuote | null;
    deliveryError: string | null;    // ADDRESS_OUT_OF_RANGE, NO_ROUTE or ROUTING_UNAVAILABLE
    totalMinor: number | null;       // subtotal + fee, only when the fee is known
};

type CartAddressRow = {
    id: string;
    label: string | null;
    street: string;
    city: string;
    lat: number;
    lng: number;
};

type CartRestaurantRow = {
    id: string;
    name: string;
    is_open: boolean;
    paused_until: Date | null;
    opening_hours: OpeningHours | null;
    lat: number; 
    lng: number;
};

const EMPTY_CART: CartView = { 
    restaurant: null,
    address: null,
    items: [],
    subtotalMinor: 0,
    currency: 'EUR',
    minOrderMinor: 0,
    meetsMinOrder: false,
    delivery: null,
    deliveryError: null,
    totalMinor: null,
};

// Used by every change to the cart. Creates the cart on first use, then locks its row
// until the transaction ends, so two changes to the same cart run one after the other.
async function getOrCreateCart(client: PoolClient, customerId: string): Promise<CartRow> {
    await client.query(
        `INSERT INTO carts (customer_id) VALUES ($1) ON CONFLICT (customer_id) DO NOTHING`,
        [customerId],
    );
    const { rows } = await client.query<CartRow>(
        `SELECT id,
                restaurant_id AS "restaurantId",
                delivery_address_id AS "deliveryAddressId"
            FROM carts
         WHERE customer_id = $1
            FOR UPDATE`,
        [customerId]
    );
    return rows[0];
}

async function getCartView(customerId: string): Promise<CartView> {
    const { min_order_minor: minOrderMinor } = await getNumberSettings(['min_order_minor'] as const);

    const cartResult = await pool.query<CartRow>(
        `SELECT id,
                restaurant_id AS "restaurantId",
                delivery_address_id AS "deliveryAddressId"
            FROM carts WHERE customer_id = $1`,
        [customerId]
    );
    const cart = cartResult.rows[0];
    if (!cart) {
         return { ...EMPTY_CART, minOrderMinor };
    }

    // lines: price and availability always come from the database, never from the cart
    const lines = await pool.query<CartLine>(
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

    let restaurantRow: CartRestaurantRow | null = null;
    let restaurant: CartView['restaurant'] = null;
    if (cart.restaurantId) {
        const r = await pool.query<CartRestaurantRow>(
            `SELECT id, name, is_open, paused_until, opening_hours, lat, lng
               FROM restaurants WHERE id = $1`,
            [cart.restaurantId]
        );
        restaurantRow = r.rows[0] ?? null;
        if (restaurantRow) {
            restaurant = {
                id: restaurantRow.id,
                name: restaurantRow.name,
                orderable: isOrderable(restaurantRow, new Date()),
            };
        }
    }

    let addressRow: CartAddressRow | null = null;
    let address: CartView['address'] = null;
    if (cart.deliveryAddressId) {
        const a = await pool.query<CartAddressRow>(
            `SELECT id, label, street, city, lat, lng FROM delivery_addresses WHERE id = $1`,
            [cart.deliveryAddressId]
        );
        addressRow = a.rows[0] ?? null;
        if (addressRow) {
            address = { id: addressRow.id, label: addressRow.label, street: addressRow.street, city: addressRow.city };
        }
    }

    const subtotalMinor = lines.rows.reduce((sum, line) => sum + line.lineTotalMinor, 0);

    // estimated delivery: needs items, a restaurant and an address
    let delivery: DeliveryQuote | null = null;
    let deliveryError: string | null = null;
    if (restaurantRow && addressRow && lines.rows.length > 0) {
        try {
            delivery = await quoteDelivery(
                { lat: restaurantRow.lat, lng: restaurantRow.lng },
                { lat: addressRow.lat, lng: addressRow.lng },
            );
        }catch (err) {
                if (!(err instanceof AppError)) {
                    throw err;
                }
                deliveryError = err.code;
            }
    }

    return {
        restaurant,
        address,
        items: lines.rows,
        subtotalMinor,
        currency: lines.rows[0]?.currency ?? 'EUR',
        minOrderMinor,
        meetsMinOrder: lines.rows.length > 0 && subtotalMinor >= minOrderMinor,
        delivery,
        deliveryError,
        totalMinor: delivery ? subtotalMinor + delivery.feeMinor : null,
    };
}

async function setCartItem(customerId: string, menuItemId: string, input: SetCartItemInput): Promise<CartView> {
    await withTransaction(async (client) => {
        const cart = await getOrCreateCart(client, customerId);

        //1. one restaurant per cart (the cart's restaurant is NULL while it is empty)
        if (cart.restaurantId !== null && cart.restaurantId !== input.restaurantId) {
            throw new AppError(409, 'CART_OTHER_RESTAURANT',
                'Your cart has items from another restaurant', { restaurantId: cart.restaurantId });
        }

        //2. the restaurant must exist and be open for customers (owned)
        const restaurant = await client.query<{ brandId: string }>(
            `SELECT brand_id AS "brandId" FROM restaurants WHERE id = $1 AND owner_id IS NOT NULL`,
            [input.restaurantId]
        );
        if (!restaurant.rows[0]) {
            throw new AppError(404, 'RESTAURANT_NOT_FOUND', 'Restaurant not found');
        }

        //3. the item must be on that restaurant's menu (same brand), active and not turned off
        const item = await client.query<{ available: boolean }>(
            `SELECT (m.is_active AND COALESCE(a.available, true)) AS available
               FROM menu_items m
               LEFT JOIN restaurant_item_availability a
                      ON a.menu_item_id = m.id AND a.restaurant_id = $2
              WHERE m.id = $1 AND m.brand_id = $3`,
              [menuItemId, input.restaurantId, restaurant.rows[0].brandId]
        );
        if (!item.rows[0]) {
            throw new AppError(404, 'MENU_ITEM_NOT_FOUND', 'Menu item not found');
        }
        if (!item.rows[0].available) {
            throw new AppError(409, 'ITEM_UNAVAILABLE', 'This item is not available right now');
        }
        // 4. the cart takes the restaurant (also bumps updated_at through the trigger)
        await client.query(`UPDATE carts SET restaurant_id = $2 WHERE id = $1`, [cart.id, input.restaurantId]);

        // 5. the line: insert, or set the new quantity if it exists
        await client.query(
            `INSERT INTO cart_items (cart_id, menu_item_id, quantity)
             VALUES ($1, $2, $3)
             ON CONFLICT (cart_id, menu_item_id) DO UPDATE SET quantity = EXCLUDED.quantity`,
             [cart.id, menuItemId, input.quantity]
        );
    }, `user:${customerId}`, 'set cart item');

    return getCartView(customerId);
}

async function removeCartItem(customerId: string, menuItemId: string): Promise<CartView> {
    await withTransaction(async (client) => {
        const cart = await getOrCreateCart(client, customerId);

        await client.query(
            `DELETE FROM cart_items WHERE cart_id = $1 AND menu_item_id = $2`,
            [cart.id, menuItemId],
        );
        // an empty cart forgets its restaurant, so the customer can start from another one
        await client.query(
            `UPDATE carts
                SET restaurant_id = CASE
                    WHEN EXISTS (SELECT 1 FROM cart_items WHERE cart_id = $1) THEN restaurant_id
                    ELSE NULL
                END
            WHERE id = $1`,
            [cart.id]
        );
    }, `user:${customerId}`, 'remove cart item');

    return getCartView(customerId);
}

async function clearCart(customerId: string): Promise<CartView> {
    await withTransaction(async (client) => {
        const cart = await getOrCreateCart(client, customerId);

        await client.query(`DELETE FROM cart_items WHERE cart_id = $1`, [cart.id]);
        await client.query(`UPDATE carts SET restaurant_id = NULL WHERE id = $1`, [cart.id]);
    }, `user:${customerId}`, 'clear cart');

    return getCartView(customerId);
}

async function setCartAddress(customerId: string, addressId: string): Promise<CartView> {
    await withTransaction(async (client) => {
        const cart = await getOrCreateCart(client, customerId);

        // the foreign key only checks that the address exists; we check that it is the customer's own
        const address = await client.query(
            `SELECT id FROM delivery_addresses WHERE id = $1 AND user_id = $2`,
            [addressId, customerId],
        );
        if (!address.rows[0]) {
            throw new AppError(404, 'ADDRESS_NOT_FOUND', 'Address not found');
        }
        await client.query(`UPDATE carts SET delivery_address_id = $1 WHERE id = $2`, [addressId, cart.id]);
    }, `user:${customerId}`, 'set cart address');

    return getCartView(customerId);
}

export { getCartView, setCartItem, removeCartItem, clearCart, setCartAddress, getOrCreateCart };
export type { CartView, CartRow };