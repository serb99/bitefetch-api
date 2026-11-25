import { pool } from './db';
import { api } from './http';
import { BRASOV, bearer } from './catalog';
import { createShop } from './customer';
import { createUser, type TestUser, type UserStatus } from './users';
import { accept, placedOrderAt, ready, type Shop } from './restaurantOrders';
import { getNumberSettings } from '../../src/services/settingsService';
import { dispatchDueOrders } from '../../src/services/dispatchService';

// M7: dispatch and courier delivery (S1-S5, T12, T13).
// Every helper here assumes the caller has called mockRoute(3001) (OSRM), like the payment and M6 tests.
// createShop() puts the restaurant at BRASOV; addAddress() puts the customer 0.01° north (~1.1 km).

type LatLng = { lat: number; lng: number };
// robot / robot_car (M9b) create a robot account: is_robot is set from the vehicle (CHECK courier_profiles_robot_vehicle_check)
type Vehicle = 'bike' | 'scooter' | 'car' | 'robot' | 'robot_car';
type Headers = { Authorization: string };

// One degree of latitude on the sphere src/utils/geo uses (radius 6 371 km), so distances come out exact
// along a meridian and within centimetres east-west at these short distances.
const METERS_PER_DEGREE = (6_371_000 * Math.PI) / 180;

// The point `northM` metres north and `eastM` metres east of `from` (negative = south / west).
function moved(from: LatLng, northM: number, eastM = 0): LatLng {
    return {
        lat: from.lat + northM / METERS_PER_DEGREE,
        lng: from.lng + eastM / (METERS_PER_DEGREE * Math.cos((from.lat * Math.PI) / 180)),
    };
}

const SETTING_KEYS = ['offer_timeout_s', 'courier_fresh_position_s', 'location_check_radius_m', 'dispatch_deadline_s'] as const;
type DispatchSettings = Record<(typeof SETTING_KEYS)[number], number>;

// The values in the test database (production values from migration 11 unless seeded with dev timers).
function dispatchSettings(): Promise<DispatchSettings> {
    return getNumberSettings(SETTING_KEYS);
}

// ---------------------------------------------------------------- couriers

interface Courier {
    user: TestUser;
    id: string;
    headers: Headers;
}

interface CourierOptions {
    vehicle?: Vehicle;
    at?: LatLng | null;      // null: no position row at all. Default: 300 m north of the restaurant.
    positionAgeS?: number;   // received_at = now() - positionAgeS (default 0: fresh)
    online?: boolean;        // default true
    wentOnlineAgoS?: number; // default 60: older couriers win distance ties
    status?: UserStatus;     // default active
}

// A courier with a profile (and a position) straight in the database, skipping signup and admin approval.
async function createCourier(options: CourierOptions = {}): Promise<Courier> {
    const user = await createUser({ role: 'courier', status: options.status });
    const online = options.online ?? true;
    await pool.query(
        `INSERT INTO courier_profiles (user_id, vehicle_type, availability, offline_reason, went_online_at, is_robot)
         VALUES ($1, $2::vehicle_type, $3::courier_availability,
                 CASE WHEN $3 = 'online' THEN NULL ELSE 'manual'::courier_offline_reason END,
                 CASE WHEN $3 = 'online' THEN now() - make_interval(secs => $4) END,
                 $2 IN ('robot', 'robot_car'))`,
        [user.id, options.vehicle ?? 'bike', online ? 'online' : 'offline', options.wentOnlineAgoS ?? 60]
    );
    const at = options.at === undefined ? moved(BRASOV, 300) : options.at;
    if (at) await setPosition(user.id, at, options.positionAgeS ?? 0);
    return { user, id: user.id, headers: bearer(user) };
}

// A courier user WITHOUT a profile (approval not done): 403 NO_COURIER_PROFILE.
async function courierWithoutProfile(): Promise<Headers> {
    return bearer(await createUser({ role: 'courier' }));
}

// Stores a position as if the phone had sent it `ageS` seconds ago.
async function setPosition(courierId: string, at: LatLng, ageS = 0): Promise<void> {
    await pool.query(
        `INSERT INTO courier_positions (courier_id, lat, lng, recorded_at, received_at)
         VALUES ($1, $2, $3, now() - make_interval(secs => $4), now() - make_interval(secs => $4))
         ON CONFLICT (courier_id) DO UPDATE SET
            lat = EXCLUDED.lat, lng = EXCLUDED.lng,
            recorded_at = EXCLUDED.recorded_at, received_at = EXCLUDED.received_at`,
        [courierId, at.lat, at.lng, ageS]
    );
}

// ---------------------------------------------------------------- courier endpoints

function courierState(courier: Courier) {
    return api().get('/courier').set(courier.headers);
}

function sendPosition(courier: Courier, at: LatLng, extra: object = {}) {
    return api().put('/courier/position').set(courier.headers)
        .send({ lat: at.lat, lng: at.lng, recordedAt: new Date().toISOString(), ...extra });
}

function setOnline(courier: Courier, online: boolean) {
    return api().post('/courier/availability').set(courier.headers).send({ online });
}

function currentOffer(courier: Courier) {
    return api().get('/courier/offers/current').set(courier.headers);
}

function acceptOffer(courier: Courier, offerId: string) {
    return api().post(`/courier/offers/${offerId}/accept`).set(courier.headers);
}

// body undefined → no body at all (the reason is optional)
function declineOffer(courier: Courier, offerId: string, body?: object) {
    const req = api().post(`/courier/offers/${offerId}/decline`).set(courier.headers);
    return body === undefined ? req : req.send(body);
}

function currentOrder(courier: Courier) {
    return api().get('/courier/orders/current').set(courier.headers);
}

function pickup(courier: Courier, orderId: string) {
    return api().post(`/courier/orders/${orderId}/pickup`).set(courier.headers);
}

function deliver(courier: Courier, orderId: string) {
    return api().post(`/courier/orders/${orderId}/deliver`).set(courier.headers);
}

// ---------------------------------------------------------------- orders ready for dispatch

// Placed, accepted (prep 10 min) and marked ready: dispatch_after = now, dispatch_state not_started.
async function readyOrderAt(shop: Shop) {
    const placed = await placedOrderAt(shop);
    const accepted = await accept(placed.orderId, shop.headers, { prepMinutes: 10 });
    if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
    const marked = await ready(placed.orderId, shop.headers);
    if (marked.status !== 200) throw new Error(`ready failed: ${marked.status} ${JSON.stringify(marked.body)}`);
    return { ...placed, owner: shop.headers };
}

// A new shop at BRASOV and one ready order in it.
async function readyOrder() {
    const shop = await createShop();
    return { shop, ...(await readyOrderAt(shop)) };
}

// Accepted but NOT ready (T11 owner cancel is only allowed here), with the dispatch time already reached.
async function acceptedDueOrder() {
    const shop = await createShop();
    const placed = await placedOrderAt(shop);
    const accepted = await accept(placed.orderId, shop.headers, { prepMinutes: 10 });
    if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
    await pool.query(`UPDATE orders SET dispatch_after = now() - interval '1 second' WHERE id = $1`, [placed.orderId]);
    return { shop, owner: shop.headers, ...placed };
}

// The courier accepted the offer for a ready order. The courier must be the only free one nearby.
async function assignedOrder(courier: Courier, order?: Awaited<ReturnType<typeof readyOrder>>) {
    const ready = order ?? (await readyOrder());
    await dispatchDueOrders();
    const offer = await pendingOfferOf(courier.id);
    if (!offer || offer.order_id !== ready.orderId) throw new Error('assignedOrder: the courier got no offer for this order');
    const res = await acceptOffer(courier, offer.id);
    if (res.status !== 200) throw new Error(`accept offer failed: ${res.status} ${JSON.stringify(res.body)}`);
    return { ...ready, offerId: offer.id };
}

// The courier stands at the restaurant and has picked the order up.
async function pickedUpOrder(courier: Courier) {
    const assigned = await assignedOrder(courier);
    await setPosition(courier.id, BRASOV);
    const res = await pickup(courier, assigned.orderId);
    if (res.status !== 200) throw new Error(`pickup failed: ${res.status} ${JSON.stringify(res.body)}`);
    const door = await deliveryPoint(assigned.orderId);
    return { ...assigned, door };
}

// ---------------------------------------------------------------- database readers and time travel

interface DispatchRow {
    status: string;
    version: number;
    dispatch_state: string;
    dispatch_round: number;
    dispatch_after: Date | null;
    dispatch_started_at: Date | null;
    dispatch_deadline: Date | null;
    next_search_at: Date | null;
    courier_id: string | null;
    ready_at: Date | null;
    picked_up_at: Date | null;
    estimated_delivery_at: Date | null;
    delivered_at: Date | null;
    ended_at: Date | null;
    payment_status: string;
    db_now: Date;
}

async function dispatchRow(orderId: string): Promise<DispatchRow> {
    const { rows } = await pool.query<DispatchRow>(
        `SELECT status, version, dispatch_state, dispatch_round, dispatch_after, dispatch_started_at, dispatch_deadline,
                next_search_at, courier_id, ready_at, picked_up_at, estimated_delivery_at, delivered_at, ended_at,
                payment_status, now() AS db_now
           FROM orders WHERE id = $1`,
        [orderId]
    );
    return rows[0];
}

async function deliveryPoint(orderId: string): Promise<LatLng> {
    const { rows } = await pool.query(`SELECT delivery_lat AS lat, delivery_lng AS lng FROM orders WHERE id = $1`, [orderId]);
    return rows[0];
}

interface OfferRow {
    id: string;
    order_id: string;
    courier_id: string;
    round: number;
    status: string;
    offered_at: Date;
    expires_at: Date;
    responded_at: Date | null;
    distance_m: number | null;
    decline_reason: string | null;
}

const OFFER_COLUMNS = `id, order_id, courier_id, round, status, offered_at, expires_at, responded_at, distance_m, decline_reason`;

async function offersFor(orderId: string): Promise<OfferRow[]> {
    const { rows } = await pool.query<OfferRow>(`SELECT ${OFFER_COLUMNS} FROM order_offers WHERE order_id = $1 ORDER BY id`, [orderId]);
    return rows;
}

async function offersOf(courierId: string): Promise<OfferRow[]> {
    const { rows } = await pool.query<OfferRow>(`SELECT ${OFFER_COLUMNS} FROM order_offers WHERE courier_id = $1 ORDER BY id`, [courierId]);
    return rows;
}

async function pendingOfferOf(courierId: string): Promise<OfferRow | undefined> {
    return (await offersOf(courierId)).find((o) => o.status === 'pending');
}

async function allPendingOffers(): Promise<OfferRow[]> {
    const { rows } = await pool.query<OfferRow>(`SELECT ${OFFER_COLUMNS} FROM order_offers WHERE status = 'pending' ORDER BY id`);
    return rows;
}

async function profileRow(courierId: string) {
    const { rows } = await pool.query<{
        availability: string;
        offline_reason: string | null;
        went_online_at: Date | null;
        consecutive_missed_offers: number;
    }>(
        `SELECT availability, offline_reason, went_online_at, consecutive_missed_offers FROM courier_profiles WHERE user_id = $1`,
        [courierId]
    );
    return rows[0];
}

async function positionRows(courierId: string) {
    const { rows } = await pool.query<{
        lat: number; lng: number; accuracy_m: number | null; heading_deg: number | null; speed_mps: number | null;
        recorded_at: Date; received_at: Date; db_now: Date;
    }>(
        `SELECT lat, lng, accuracy_m, heading_deg, speed_mps, recorded_at, received_at, now() AS db_now
           FROM courier_positions WHERE courier_id = $1`,
        [courierId]
    );
    return rows;
}

// The courier's time to answer is over (the sweep has not run yet).
async function passOfferDeadline(offerId: string): Promise<void> {
    // offered_at moves back too: the CHECK order_offers_expiry_after_offer wants expires_at > offered_at
    await pool.query(
        `UPDATE order_offers SET offered_at = now() - interval '1 minute', expires_at = now() - interval '1 second' WHERE id = $1`,
        [offerId]
    );
}

// The order's backoff wait is over: the next dispatch pass searches it again.
async function makeSearchDue(orderId: string): Promise<void> {
    await pool.query(`UPDATE orders SET next_search_at = now() - interval '1 second' WHERE id = $1`, [orderId]);
}

async function setCourierOffline(courierId: string): Promise<void> {
    await pool.query(`UPDATE courier_profiles SET availability = 'offline', offline_reason = 'manual' WHERE user_id = $1`, [courierId]);
}

export {
    METERS_PER_DEGREE, moved, dispatchSettings,
    createCourier, courierWithoutProfile, setPosition,
    courierState, sendPosition, setOnline, currentOffer, acceptOffer, declineOffer, currentOrder, pickup, deliver,
    readyOrderAt, readyOrder, acceptedDueOrder, assignedOrder, pickedUpOrder,
    dispatchRow, deliveryPoint, offersFor, offersOf, pendingOfferOf, allPendingOffers, profileRow, positionRows,
    passOfferDeadline, makeSearchDue, setCourierOffline,
};
export type { LatLng, Courier, DispatchRow, OfferRow };
