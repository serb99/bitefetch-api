import { BRASOV } from '../../helpers/catalog';
import { mockRoute, checkout, readyCart, countOrders } from '../../helpers/customer';
import { TOTAL } from '../../helpers/payments';
import { createCourier, moved, assignedOrder } from '../../helpers/dispatch';
import { setSetting, restoreSettings } from '../../helpers/worker';
import { fakeStripe } from '../../helpers/fakeStripe';

// Checkout guard: checkout is refused when no courier could deliver: no online, active courier with a
// fresh position within 10 km of the restaurant. Switch: platform setting checkout_courier_check (0 for the
// other test files, see tests/helpers/setupDb.ts).

beforeEach(async () => {
    mockRoute(3001);
    await setSetting('checkout_courier_check', 1);
});

afterEach(restoreSettings);

async function expectRefused() {
    const { customer } = await readyCart();
    const res = await checkout(customer, TOTAL);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('NO_COURIER_NEARBY');
    expect(await countOrders()).toBe(0);
    expect(fakeStripe.calls('create')).toHaveLength(0);
}

it('nobody around: 409 NO_COURIER_NEARBY, no order, no PaymentIntent, the cart is kept', async () => {
    await expectRefused();
});

it('a fresh online courier 9.9 km away: the checkout goes through', async () => {
    await createCourier({ at: moved(BRASOV, 9_900) });
    const { customer } = await readyCart();

    const res = await checkout(customer, TOTAL);

    expect(res.status).toBe(201);
});

it('a busy courier counts (they may be free when the food is ready)', async () => {
    const courier = await createCourier();
    await assignedOrder(courier); // the only courier now has a delivery
    const { customer } = await readyCart();

    expect((await checkout(customer, TOTAL)).status).toBe(201);
});

it('only 10.1 km away: refused', async () => {
    await createCourier({ at: moved(BRASOV, 10_100) });
    await expectRefused();
});

it('a stale position (40 s old): refused', async () => {
    await createCourier({ positionAgeS: 40 });
    await expectRefused();
});

it('offline, or suspended: refused', async () => {
    await createCourier({ online: false });
    await createCourier({ status: 'suspended' });
    await expectRefused();
});

it('switched off (0): no check at all', async () => {
    await setSetting('checkout_courier_check', 0);
    const { customer } = await readyCart();

    expect((await checkout(customer, TOTAL)).status).toBe(201);
});
