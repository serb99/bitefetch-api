import { api } from '../../helpers/http';
import { pool } from '../../helpers/db';
import { createUser } from '../../helpers/users';
import { BRASOV, bearer, createMenuItem, createOwnerWithRestaurant, createRestaurant, setAvailability } from '../../helpers/catalog';
import {
    mockRoute, osrmResponse, createCustomer, addAddress, createShop, setItem, setCartAddress, getCart,
} from '../../helpers/customer';

describe('access', () => {
    it('needs a login (401) and the customer role (403)', async () => {
        expect((await api().get('/cart')).status).toBe(401);

        const courier = await createUser({ role: 'courier' });
        expect((await api().get('/cart').set(bearer(courier))).status).toBe(403);
    });
});

describe('GET /cart', () => {
    it('an empty cart has no restaurant, no total and the minimum order from the settings', async () => {
        const c = await createCustomer();

        const res = await getCart(c);

        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            restaurant: null, address: null, items: [], subtotalMinor: 0, currency: 'EUR',
            minOrderMinor: 500, meetsMinOrder: false, delivery: null, deliveryError: null, totalMinor: null,
        });
    });

    it('prices always come from the menu, not from the moment the item was added', async () => {
        const shop = await createShop({ pizzaPriceMinor: 800 });
        const c = await createCustomer();
        await setItem(c, shop.pizzaId, shop.restaurantId, 2);

        await pool.query('UPDATE menu_items SET price_minor = 900 WHERE id = $1', [shop.pizzaId]);

        const res = await getCart(c);
        expect(res.body.items[0]).toMatchObject({ unitPriceMinor: 900, quantity: 2, lineTotalMinor: 1800 });
        expect(res.body.subtotalMinor).toBe(1800);
    });
});

describe('PUT /cart/items/:id', () => {
    it('adds the line and returns the whole cart', async () => {
        const shop = await createShop();
        const c = await createCustomer();

        const res = await setItem(c, shop.pizzaId, shop.restaurantId, 2);

        expect(res.status).toBe(200);
        expect(res.body.restaurant).toEqual({ id: shop.restaurantId, name: 'Pizza Test', orderable: true });
        expect(res.body.items).toEqual([{
            menuItemId: shop.pizzaId, name: 'Pizza', unitPriceMinor: 800, currency: 'EUR',
            quantity: 2, lineTotalMinor: 1600, available: true,
        }]);
        expect(res.body).toMatchObject({ subtotalMinor: 1600, meetsMinOrder: true });
    });

    it('SETS the quantity, it does not add to it', async () => {
        const shop = await createShop();
        const c = await createCustomer();
        await setItem(c, shop.pizzaId, shop.restaurantId, 2);

        const res = await setItem(c, shop.pizzaId, shop.restaurantId, 3);

        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0].quantity).toBe(3);
    });

    it('meetsMinOrder is false below 500 cents', async () => {
        const shop = await createShop({ colaPriceMinor: 300 });
        const c = await createCustomer();

        const res = await setItem(c, shop.colaId, shop.restaurantId, 1);

        expect(res.body).toMatchObject({ subtotalMinor: 300, minOrderMinor: 500, meetsMinOrder: false });
    });

    it('one restaurant at a time: 409 CART_OTHER_RESTAURANT with the current restaurant id', async () => {
        const first = await createShop();
        const second = await createShop();
        const c = await createCustomer();
        await setItem(c, first.pizzaId, first.restaurantId, 1);

        const res = await setItem(c, second.pizzaId, second.restaurantId, 1);

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({
            code: 'CART_OTHER_RESTAURANT', details: { restaurantId: first.restaurantId },
        });
        expect((await getCart(c)).body.items.map((l: { menuItemId: string }) => l.menuItemId)).toEqual([first.pizzaId]);
    });

    it('rejects quantities outside 1..50 and a missing restaurantId (400)', async () => {
        const shop = await createShop();
        const c = await createCustomer();

        for (const body of [
            { restaurantId: shop.restaurantId, quantity: 0 },
            { restaurantId: shop.restaurantId, quantity: 51 },
            { restaurantId: shop.restaurantId, quantity: 1.5 },
            { quantity: 1 },
        ]) {
            const res = await api().put(`/cart/items/${shop.pizzaId}`).set(c.headers).send(body);
            expect(res.status).toBe(400);
        }
    });

    it('an unowned restaurant does not take orders (404 RESTAURANT_NOT_FOUND)', async () => {
        const { id, brandId } = await createRestaurant({ ownerId: null });
        const itemId = await createMenuItem(brandId);
        const c = await createCustomer();

        const res = await setItem(c, itemId, id, 1);

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('RESTAURANT_NOT_FOUND');
    });

    it('an item from another brand is not on this menu (404 MENU_ITEM_NOT_FOUND)', async () => {
        const shop = await createShop();
        const other = await createShop();
        const c = await createCustomer();

        const res = await setItem(c, other.pizzaId, shop.restaurantId, 1);

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('MENU_ITEM_NOT_FOUND');
    });

    it('an inactive item, or one turned off at this restaurant, is 409 ITEM_UNAVAILABLE', async () => {
        const shop = await createShop();
        const inactive = await createMenuItem(shop.brandId, { isActive: false });
        await setAvailability(shop.restaurantId, shop.colaId, false);
        const c = await createCustomer();

        for (const itemId of [inactive, shop.colaId]) {
            const res = await setItem(c, itemId, shop.restaurantId, 1);
            expect(res.status).toBe(409);
            expect(res.body.error.code).toBe('ITEM_UNAVAILABLE');
        }
    });

    it('an item that became unavailable later stays in the cart, marked available: false', async () => {
        const shop = await createShop();
        const c = await createCustomer();
        await setItem(c, shop.pizzaId, shop.restaurantId, 1);

        await pool.query('UPDATE menu_items SET is_active = false WHERE id = $1', [shop.pizzaId]);

        expect((await getCart(c)).body.items[0]).toMatchObject({ menuItemId: shop.pizzaId, available: false });
    });

    it('shows orderable: false when the restaurant is closed', async () => {
        const shop = await createShop();
        const c = await createCustomer();
        await setItem(c, shop.pizzaId, shop.restaurantId, 1);

        await pool.query('UPDATE restaurants SET is_open = false WHERE id = $1', [shop.restaurantId]);

        expect((await getCart(c)).body.restaurant.orderable).toBe(false);
    });
});

describe('DELETE /cart/items/:id and DELETE /cart', () => {
    it('removing the last line forgets the restaurant, so another restaurant can be started', async () => {
        const first = await createShop();
        const second = await createShop();
        const c = await createCustomer();
        await setItem(c, first.pizzaId, first.restaurantId, 1);

        const res = await api().delete(`/cart/items/${first.pizzaId}`).set(c.headers);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ restaurant: null, items: [] });

        expect((await setItem(c, second.pizzaId, second.restaurantId, 1)).status).toBe(200);
    });

    it('removing one of two lines keeps the restaurant', async () => {
        const shop = await createShop();
        const c = await createCustomer();
        await setItem(c, shop.pizzaId, shop.restaurantId, 1);
        await setItem(c, shop.colaId, shop.restaurantId, 1);

        const res = await api().delete(`/cart/items/${shop.colaId}`).set(c.headers);

        expect(res.body.restaurant.id).toBe(shop.restaurantId);
        expect(res.body.items).toHaveLength(1);
    });

    it('clearing empties the cart but keeps the chosen address', async () => {
        mockRoute(1000);
        const shop = await createShop();
        const c = await createCustomer();
        const a = await addAddress(c);
        await setItem(c, shop.pizzaId, shop.restaurantId, 2);
        await setCartAddress(c, a.id);

        const res = await api().delete('/cart').set(c.headers);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ restaurant: null, items: [], totalMinor: null });
        expect(res.body.address.id).toBe(a.id);
    });
});

describe('PUT /cart/address', () => {
    it('only my own address (404 ADDRESS_NOT_FOUND for someone else\'s)', async () => {
        const c = await createCustomer();
        const other = await addAddress(await createCustomer());

        const res = await setCartAddress(c, other.id);

        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('ADDRESS_NOT_FOUND');
    });

    it('returns the cart with the address', async () => {
        const c = await createCustomer();
        const a = await addAddress(c, { label: 'Home', street: 'Strada Lunga 5', city: 'Brasov' });

        const res = await setCartAddress(c, a.id);

        expect(res.status).toBe(200);
        expect(res.body.address).toEqual({ id: a.id, label: 'Home', street: 'Strada Lunga 5', city: 'Brasov' });
    });
});

describe('delivery quote in the cart', () => {
    async function cartWithAddress() {
        const shop = await createShop();
        const c = await createCustomer();
        const a = await addAddress(c, { lat: BRASOV.lat + 0.02, lng: BRASOV.lng + 0.01 });
        await setItem(c, shop.pizzaId, shop.restaurantId, 2);   // 1600
        await setCartAddress(c, a.id);
        return c;
    }

    it('needs items and an address; then shows distance, fee and total', async () => {
        const fetchMock = mockRoute(3001, 540);
        const c = await cartWithAddress();

        const res = await getCart(c);

        expect(res.body.delivery).toEqual({ distanceM: 3001, durationS: 540, feeMinor: 190 });
        expect(res.body).toMatchObject({ deliveryError: null, subtotalMinor: 1600, totalMinor: 1790 });
        expect(fetchMock).toHaveBeenCalled();
    });

    it('asks OSRM with longitude first, restaurant to address', async () => {
        const fetchMock = mockRoute(1000);
        await cartWithAddress();

        const url = String(fetchMock.mock.calls[0][0]);
        const from = `${BRASOV.lng},${BRASOV.lat}`;
        const to = `${Number((BRASOV.lng + 0.01).toFixed(4))},${Number((BRASOV.lat + 0.02).toFixed(4))}`;
        expect(url).toContain(`/route/v1/driving/${from};${to}?`);
    });

    it('caches the route: the next cart views do not call OSRM again', async () => {
        const fetchMock = mockRoute(1000);
        const c = await cartWithAddress();
        const callsAfterSetup = fetchMock.mock.calls.length;

        await getCart(c);
        await getCart(c);

        expect(callsAfterSetup).toBe(1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const { rows } = await pool.query('SELECT distance_m FROM route_cache');
        expect(rows).toEqual([{ distance_m: 1000 }]);
    });

    it('7000 m is still delivered (310 cents); 7001 m is ADDRESS_OUT_OF_RANGE with no total', async () => {
        mockRoute(7000);
        const c = await cartWithAddress();
        expect((await getCart(c)).body.delivery.feeMinor).toBe(310);

        await pool.query('UPDATE route_cache SET distance_m = 7001');
        const res = await getCart(c);

        expect(res.body).toMatchObject({ delivery: null, deliveryError: 'ADDRESS_OUT_OF_RANGE', totalMinor: null });
    });

    it('OSRM down: deliveryError ROUTING_UNAVAILABLE (the cart itself still loads)', async () => {
        jest.spyOn(global, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
        const c = await cartWithAddress();

        const res = await getCart(c);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ deliveryError: 'ROUTING_UNAVAILABLE', delivery: null, totalMinor: null });
        expect(res.body.items).toHaveLength(1);
    });

    it('no road to the address: deliveryError NO_ROUTE', async () => {
        jest.spyOn(global, 'fetch').mockImplementation(async () => osrmResponse({ code: 'NoRoute' }));
        const c = await cartWithAddress();

        expect((await getCart(c)).body.deliveryError).toBe('NO_ROUTE');
    });

    it('no quote without an address (OSRM is not called)', async () => {
        const fetchMock = mockRoute(1000);
        const shop = await createOwnerWithRestaurant();
        const itemId = await createMenuItem(shop.brandId, { priceMinor: 800 });
        const c = await createCustomer();
        await setItem(c, itemId, shop.restaurantId, 1);

        const res = await getCart(c);

        expect(res.body).toMatchObject({ address: null, delivery: null, deliveryError: null, totalMinor: null });
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
