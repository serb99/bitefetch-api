import { pool } from './db';
import { api } from './http';
import { createUser, type TestUser } from './users';
import { BRASOV, bearer, createOwnerWithRestaurant, createMenuItem } from './catalog';

// OSRM is never called for real. Every test that needs a route mocks global fetch with one of these.
function osrmResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Every OSRM call answers with a driving route of `distanceM` metres.
function mockRoute(distanceM: number, durationS = 600): jest.SpyInstance {
    return jest.spyOn(global, 'fetch').mockImplementation(async () =>
        osrmResponse({ code: 'Ok', routes: [{ distance: distanceM, duration: durationS, geometry: 'abc' }] }),
    );
}

interface Customer {
    user: TestUser;
    headers: { Authorization: string };
}

async function createCustomer(): Promise<Customer> {
    const user = await createUser({ role: 'customer' });
    return { user, headers: bearer(user) };
}

interface AddressOptions {
    label?: string | null;
    street?: string;
    details?: string | null;
    city?: string;
    lat?: number;
    lng?: number;
}

// Through the API, so the "first one is the default" rule applies like in the app.
async function addAddress(customer: Customer, options: AddressOptions = {}): Promise<{ id: string; isDefault: boolean }> {
    const res = await api().post('/addresses').set(customer.headers).send({
        label: options.label ?? null,
        street: options.street ?? 'Strada Lunga 5',
        details: options.details ?? null,
        city: options.city ?? 'Brasov',
        lat: options.lat ?? BRASOV.lat + 0.01,
        lng: options.lng ?? BRASOV.lng,
    });
    if (res.status !== 201) {
        throw new Error(`addAddress failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res.body;
}

// An open, owned restaurant with two menu items.
async function createShop(options: { pizzaPriceMinor?: number; colaPriceMinor?: number } = {}) {
    const shop = await createOwnerWithRestaurant({ name: 'Pizza Test' });
    const pizzaId = await createMenuItem(shop.brandId, { name: 'Pizza', priceMinor: options.pizzaPriceMinor ?? 800 });
    const colaId = await createMenuItem(shop.brandId, { name: 'Cola', priceMinor: options.colaPriceMinor ?? 300 });
    return { ...shop, pizzaId, colaId };
}

function setItem(customer: Customer, menuItemId: string, restaurantId: string, quantity: number) {
    return api().put(`/cart/items/${menuItemId}`).set(customer.headers).send({ restaurantId, quantity });
}

function setCartAddress(customer: Customer, addressId: string) {
    return api().put('/cart/address').set(customer.headers).send({ addressId });
}

function getCart(customer: Customer) {
    return api().get('/cart').set(customer.headers);
}

function checkout(customer: Customer, expectedTotalMinor: number, key: string | null = 'key-1') {
    const req = api().post('/orders').set(customer.headers);
    if (key !== null) req.set('Idempotency-Key', key);
    return req.send({ expectedTotalMinor });
}

// A customer with an address and `pizzas` x Pizza (800) in the cart, ready for checkout.
async function readyCart(pizzas = 2) {
    const shop = await createShop();
    const customer = await createCustomer();
    const address = await addAddress(customer);
    await setItem(customer, shop.pizzaId, shop.restaurantId, pizzas);
    await setCartAddress(customer, address.id);
    return { shop, customer, address };
}

async function countOrders(): Promise<number> {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM orders');
    return rows[0].n;
}

export {
    osrmResponse, mockRoute, createCustomer, addAddress, createShop,
    setItem, setCartAddress, getCart, checkout, readyCart, countOrders,
};
export type { Customer };
