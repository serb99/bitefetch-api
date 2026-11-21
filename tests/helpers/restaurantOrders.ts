import { pool } from './db';
import { api } from './http';
import { addAddress, checkout, createCustomer, createShop, setCartAddress, setItem, type Customer } from './customer';
import { createUser } from './users';
import { bearer } from './catalog';
import { TOTAL, authorize, orderRow } from './payments';

// M6: restaurant order handling (T6 accept, T7 reject, T8 timeout, T9 customer cancel, T10 ready, T11 owner cancel).
// Every helper here assumes the caller has called mockRoute(3001) (OSRM), like the payment tests.

type Shop = Awaited<ReturnType<typeof createShop>>;
type Headers = { Authorization: string };

// A new customer orders 2 x Pizza (total 1790) at an existing shop: pending_payment.
// Several orders can go to the same restaurant this way (readyCart always creates a new shop).
async function pendingOrderAt(shop: Shop, key = 'key-1') {
    const customer = await createCustomer();
    const address = await addAddress(customer);
    await setItem(customer, shop.pizzaId, shop.restaurantId, 2);
    await setCartAddress(customer, address.id);
    const res = await checkout(customer, TOTAL, key);
    if (res.status !== 201) {
        throw new Error(`checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    const orderId = res.body.id as string;
    const piId = (await orderRow(orderId)).stripe_payment_intent_id as string;
    return { orderId, customer, piId };
}

// Paid (authorized at the fake Stripe, webhook received): placed, accept_deadline = now + 5 min.
async function placedOrderAt(shop: Shop): Promise<{ orderId: string; customer: Customer; piId: string }> {
    const pending = await pendingOrderAt(shop);
    await authorize(pending.orderId, pending.piId);
    return pending;
}

// A shop (with its owner) and one placed order in it.
async function placedOrder() {
    const shop = await createShop();
    const placed = await placedOrderAt(shop);
    return { shop, owner: shop.headers, ...placed };
}

// A shop and one order already accepted by the owner (prep 20 min by default).
async function acceptedOrder(prepMinutes?: number) {
    const placed = await placedOrder();
    const res = await accept(placed.orderId, placed.owner, prepMinutes === undefined ? undefined : { prepMinutes });
    if (res.status !== 200) throw new Error(`accept failed: ${res.status} ${JSON.stringify(res.body)}`);
    return placed;
}

// ---------------------------------------------------------------- owner endpoints

function board(headers?: Headers) {
    const req = api().get('/owner/orders');
    return headers ? req.set(headers) : req;
}

// body undefined → the request has no body at all (the web's plain "Accept" click).
function accept(orderId: string, headers?: Headers, body?: object) {
    const req = api().post(`/owner/orders/${orderId}/accept`);
    if (headers) req.set(headers);
    return body === undefined ? req : req.send(body);
}

function reject(orderId: string, headers: Headers, body: object = { reasonCode: 'too_busy' }) {
    return api().post(`/owner/orders/${orderId}/reject`).set(headers).send(body);
}

function ready(orderId: string, headers: Headers) {
    return api().post(`/owner/orders/${orderId}/ready`).set(headers);
}

function ownerCancel(orderId: string, headers: Headers, body: object = { reasonCode: 'kitchen_issue' }) {
    return api().post(`/owner/orders/${orderId}/cancel`).set(headers).send(body);
}

function customerCancel(orderId: string, customer: Customer) {
    return api().post(`/orders/${orderId}/cancel`).set(customer.headers);
}

// An active restaurant owner who owns nothing (403 NO_RESTAURANT).
async function ownerWithoutRestaurant(): Promise<Headers> {
    const user = await createUser({ role: 'restaurant_owner' });
    return bearer(user);
}

// ---------------------------------------------------------------- database readers and fixtures

interface KitchenRow {
    status: string;
    version: number;
    cancelled_by: string | null;
    cancel_reason: string | null;
    cancel_note: string | null;
    ended_at: Date | null;
    accept_deadline: Date | null;
    accepted_at: Date | null;
    prep_minutes: number | null;
    estimated_ready_at: Date | null;
    dispatch_after: Date | null;
    dispatch_state: string;
    ready_at: Date | null;
    courier_id: string | null;
}

async function kitchenRow(orderId: string): Promise<KitchenRow> {
    const { rows } = await pool.query<KitchenRow>(
        `SELECT status, version, cancelled_by, cancel_reason, cancel_note, ended_at, accept_deadline,
                accepted_at, prep_minutes, estimated_ready_at, dispatch_after, dispatch_state, ready_at, courier_id
           FROM orders WHERE id = $1`,
        [orderId]
    );
    return rows[0];
}

async function restaurantRow(restaurantId: string): Promise<{ consecutive_timeouts: number; paused_until: Date | null }> {
    const { rows } = await pool.query(
        `SELECT consecutive_timeouts, paused_until FROM restaurants WHERE id = $1`,
        [restaurantId]
    );
    return rows[0];
}

async function setMissedOrders(restaurantId: string, missed: number, pausedUntil: Date | null = null): Promise<void> {
    await pool.query(
        `UPDATE restaurants SET consecutive_timeouts = $2, paused_until = $3 WHERE id = $1`,
        [restaurantId, missed, pausedUntil]
    );
}

// The restaurant's time to answer is over (the sweep has not run yet).
async function passAcceptDeadline(orderId: string): Promise<void> {
    await pool.query(`UPDATE orders SET accept_deadline = now() - interval '1 second' WHERE id = $1`, [orderId]);
}

async function openKitchenLate(orderId: string, restaurantId: string): Promise<void> {
    await pool.query(
        `INSERT INTO order_incidents (order_id, restaurant_id, type, opened_by) VALUES ($1, $2, 'kitchen_late', 'system')`,
        [orderId, restaurantId]
    );
}

interface IncidentRow {
    order_id: string | null;
    restaurant_id: string;
    type: string;
    opened_by: string;
    details: string | null;
    resolved_at: Date | null;
    resolution_note: string | null;
}

async function incidents(restaurantId: string): Promise<IncidentRow[]> {
    const { rows } = await pool.query<IncidentRow>(
        `SELECT order_id, restaurant_id, type, opened_by, details, resolved_at, resolution_note
           FROM order_incidents WHERE restaurant_id = $1 ORDER BY id`,
        [restaurantId]
    );
    return rows;
}

// A courier who is still deciding on this order (M7 creates these; here they are inserted directly).
async function pendingOffer(orderId: string): Promise<string> {
    const courier = await createUser({ role: 'courier' });
    const { rows } = await pool.query(
        `INSERT INTO order_offers (order_id, courier_id, expires_at) VALUES ($1, $2, now() + interval '30 seconds') RETURNING id`,
        [orderId, courier.id]
    );
    return rows[0].id;
}

async function offerRow(offerId: string): Promise<{ status: string; responded_at: Date | null }> {
    const { rows } = await pool.query(`SELECT status, responded_at FROM order_offers WHERE id = $1`, [offerId]);
    return rows[0];
}

// Full history rows (the payments helper returns only from/to/actor).
async function historyWithReason(orderId: string): Promise<{ from_status: string | null; to_status: string; actor: string; reason: string | null }[]> {
    const { rows } = await pool.query(
        `SELECT from_status, to_status, actor, reason FROM order_status_history WHERE order_id = $1 ORDER BY at, id`,
        [orderId]
    );
    return rows;
}

export {
    pendingOrderAt, placedOrderAt, placedOrder, acceptedOrder,
    board, accept, reject, ready, ownerCancel, customerCancel, ownerWithoutRestaurant,
    kitchenRow, restaurantRow, setMissedOrders, passAcceptDeadline, openKitchenLate, incidents,
    pendingOffer, offerRow, historyWithReason,
};
export type { Shop };
