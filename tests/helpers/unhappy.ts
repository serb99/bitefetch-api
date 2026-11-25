import { pool } from './db';
import { api, login } from './http';
import { createUser, type TestUser } from './users';
import type { Customer } from './customer';
import type { Courier } from './dispatch';

// Unhappy paths, incidents and the admin's order actions.
// Like the restaurant order and dispatch helpers, the callers mock OSRM with mockRoute(3001).

type Headers = { Authorization: string };

interface Admin {
    user: TestUser;
    id: string;
    headers: Headers;
}

// The admin routes check the session in the database (requireLiveSession), so the admin logs in for real:
// a token made by tokenFor() has no refresh token family behind it.
async function createAdmin(): Promise<Admin> {
    const user = await createUser({ role: 'admin' });
    const { accessToken } = await login(user.email, user.password);
    return { user, id: user.id, headers: { Authorization: `Bearer ${accessToken}` } };
}

// ---------------------------------------------------------------- endpoints

function adminGetOrder(admin: Admin, orderId: string) {
    return api().get(`/admin/orders/${orderId}`).set(admin.headers);
}

type AdminOrderAction = 'cancel' | 'mark-picked-up' | 'mark-delivered' | 'retry-dispatch' | 'reassign-courier';

function adminAction(admin: Admin | Headers, orderId: string, action: AdminOrderAction, body: object) {
    const headers = 'headers' in admin ? admin.headers : admin;
    return api().post(`/admin/orders/${orderId}/${action}`).set(headers).send(body);
}

function decideCancelRequest(admin: Admin, requestId: string, decision: 'approve' | 'reject', body: object) {
    return api().post(`/admin/cancel-requests/${requestId}/${decision}`).set(admin.headers).send(body);
}

function requestCancel(orderId: string, owner: Headers, body: object = { reasonCode: 'kitchen_issue' }) {
    return api().post(`/owner/orders/${orderId}/cancel-request`).set(owner).send(body);
}

function reportProblem(courier: Courier, orderId: string, body: object) {
    return api().post(`/courier/orders/${orderId}/problems`).set(courier.headers).send(body);
}

// body undefined → no body (the plain Cancel button)
function cancelWithBody(orderId: string, customer: Customer, body?: object) {
    const req = api().post(`/orders/${orderId}/cancel`).set(customer.headers);
    return body === undefined ? req : req.send(body);
}

// The version the admin "saw": what the order has right now.
async function orderVersion(orderId: string): Promise<number> {
    const { rows } = await pool.query(`SELECT version FROM orders WHERE id = $1`, [orderId]);
    return rows[0].version;
}

// ---------------------------------------------------------------- time travel

// The courier search ran out of time (the no_courier sweep is due).
async function passDispatchDeadline(orderId: string): Promise<void> {
    await pool.query(`UPDATE orders SET dispatch_deadline = now() - interval '1 second' WHERE id = $1`, [orderId]);
}

// The courier search started `seconds` ago (the second round needs second_round_after_s = 300). The deadline is kept in the future.
async function ageDispatch(orderId: string, seconds: number): Promise<void> {
    await pool.query(
        `UPDATE orders SET dispatch_started_at = now() - make_interval(secs => $2) WHERE id = $1`,
        [orderId, seconds]
    );
}

// Still accepted, and the promised ready time was `seconds` ago.
async function ageReadyTime(orderId: string, seconds: number): Promise<void> {
    await pool.query(`UPDATE orders SET estimated_ready_at = now() - make_interval(secs => $2) WHERE id = $1`, [orderId, seconds]);
}

// Picked up, and the delivery ETA was `seconds` ago.
async function ageDeliveryEta(orderId: string, seconds: number): Promise<void> {
    await pool.query(`UPDATE orders SET estimated_delivery_at = now() - make_interval(secs => $2) WHERE id = $1`, [orderId, seconds]);
}

// The incident was opened `seconds` ago (the 10 min wait at the door).
async function ageIncident(incidentId: string, seconds: number): Promise<void> {
    await pool.query(`UPDATE order_incidents SET opened_at = now() - make_interval(secs => $2) WHERE id = $1`, [incidentId, seconds]);
}

// ---------------------------------------------------------------- database readers

interface OrderIncidentRow {
    id: string;
    type: string;
    category: string | null;
    opened_by: string;
    opened_by_user_id: string | null;
    details: string | null;
    resolved_at: Date | null;
    resolved_by: string | null;
    resolution_note: string | null;
}

async function incidentsOf(orderId: string): Promise<OrderIncidentRow[]> {
    const { rows } = await pool.query<OrderIncidentRow>(
        `SELECT id, type, category, opened_by, opened_by_user_id, details, resolved_at, resolved_by, resolution_note
           FROM order_incidents WHERE order_id = $1 ORDER BY id`,
        [orderId]
    );
    return rows;
}

async function openIncidentsOf(orderId: string): Promise<OrderIncidentRow[]> {
    return (await incidentsOf(orderId)).filter((i) => i.resolved_at === null);
}

interface CancelRequestRow {
    id: string;
    status: string;
    reason_code: string;
    note: string | null;
    requested_by: string;
    decided_by: string | null;
    decided_at: Date | null;
    version: number;
}

async function cancelRequestsOf(orderId: string): Promise<CancelRequestRow[]> {
    const { rows } = await pool.query<CancelRequestRow>(
        `SELECT id, status, reason_code, note, requested_by, decided_by, decided_at, version
           FROM order_cancel_requests WHERE order_id = $1 ORDER BY id`,
        [orderId]
    );
    return rows;
}

async function itemAvailability(restaurantId: string, menuItemId: string): Promise<boolean | null> {
    const { rows } = await pool.query(
        `SELECT available FROM restaurant_item_availability WHERE restaurant_id = $1 AND menu_item_id = $2`,
        [restaurantId, menuItemId]
    );
    return rows[0]?.available ?? null;
}

async function setMissedOffers(courierId: string, missed: number): Promise<void> {
    await pool.query(`UPDATE courier_profiles SET consecutive_missed_offers = $2 WHERE user_id = $1`, [courierId, missed]);
}

export {
    createAdmin, adminGetOrder, adminAction, decideCancelRequest, requestCancel, reportProblem, cancelWithBody, orderVersion,
    passDispatchDeadline, ageDispatch, ageReadyTime, ageDeliveryEta, ageIncident,
    incidentsOf, openIncidentsOf, cancelRequestsOf, itemAvailability, setMissedOffers,
};
export type { Admin, OrderIncidentRow, CancelRequestRow };
