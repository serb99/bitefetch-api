import { pool } from './db';
import { api } from './http';
import { addAddress, createCustomer, getCart, setCartAddress, setItem, type Customer } from './customer';
import { authorize, orderRow } from './payments';
import { accept, ready, type Shop } from './restaurantOrders';

// M9b: robot couriers. Like the other helpers, the caller mocks OSRM with mockRoute(distanceM): the mocked
// distance decides the vehicle (sidewalk robot up to robot_max_distance_m 2000, robot car beyond) and the fees.
// With the default fee settings: 1500 m → human 150, robot 75 (50% off); 3001 m → human 190, robot car 133 (30% off).

type Headers = { Authorization: string };

// POST /orders with a delivery mode. mode undefined → the field is left out (the pre-M9b body).
function checkoutAs(customer: Customer, expectedTotalMinor: number, mode?: string, key = 'key-1') {
    const body: Record<string, unknown> = { expectedTotalMinor };
    if (mode !== undefined) body.deliveryMode = mode;
    return api().post('/orders').set(customer.headers).set('Idempotency-Key', key).send(body);
}

// A customer (new, or the given one) with 2 x Pizza from `shop` and a new address in the cart.
async function fillCart(shop: Shop, customer?: Customer): Promise<Customer> {
    const who = customer ?? (await createCustomer());
    const address = await addAddress(who);
    await setItem(who, shop.pizzaId, shop.restaurantId, 2);
    await setCartAddress(who, address.id);
    return who;
}

// A robot order at `shop`, paid (placed) at the robot total the cart shows. key: a new one per order of the same customer.
async function placedRobotOrderAt(shop: Shop, customer?: Customer, key = 'key-1') {
    const who = await fillCart(shop, customer);
    const cart = await getCart(who);
    const total = cart.body.robotTotalMinor as number | null;
    if (total === null) throw new Error(`placedRobotOrderAt: the cart has no robot total ${JSON.stringify(cart.body)}`);
    const res = await checkoutAs(who, total, 'robot', key);
    if (res.status !== 201) throw new Error(`robot checkout failed: ${res.status} ${JSON.stringify(res.body)}`);
    const orderId = res.body.id as string;
    const piId = (await orderRow(orderId)).stripe_payment_intent_id as string;
    await authorize(orderId, piId);
    return { orderId, customer: who, total };
}

// Placed, accepted and marked ready: dispatch_after = now (the dispatch claims it at the next pass).
async function readyRobotOrderAt(shop: Shop, customer?: Customer, key = 'key-1') {
    const placed = await placedRobotOrderAt(shop, customer, key);
    const accepted = await accept(placed.orderId, shop.headers as Headers, { prepMinutes: 10 });
    if (accepted.status !== 200) throw new Error(`accept failed: ${accepted.status} ${JSON.stringify(accepted.body)}`);
    const marked = await ready(placed.orderId, shop.headers as Headers);
    if (marked.status !== 200) throw new Error(`ready failed: ${marked.status} ${JSON.stringify(marked.body)}`);
    return placed;
}

async function orderMode(orderId: string): Promise<{ delivery_mode: string; delivery_fee_minor: number; total_minor: number }> {
    const { rows } = await pool.query(
        `SELECT delivery_mode, delivery_fee_minor, total_minor FROM orders WHERE id = $1`,
        [orderId]
    );
    return rows[0];
}

// The robot was started `seconds` ago and nothing else happened (robot-idle looks at went_online_at and offers).
async function ageRobot(robotId: string, seconds: number): Promise<void> {
    await pool.query(
        `UPDATE courier_profiles SET went_online_at = now() - make_interval(secs => $2) WHERE user_id = $1`,
        [robotId, seconds]
    );
    await pool.query(
        `UPDATE order_offers SET offered_at = offered_at - make_interval(secs => $2),
                                 expires_at = expires_at - make_interval(secs => $2)
          WHERE courier_id = $1`,
        [robotId, seconds]
    );
}

export { checkoutAs, fillCart, placedRobotOrderAt, readyRobotOrderAt, orderMode, ageRobot };
