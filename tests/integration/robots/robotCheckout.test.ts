import { api } from '../../helpers/http';
import { mockRoute, createShop, getCart, countOrders } from '../../helpers/customer';
import { createCourier } from '../../helpers/dispatch';
import { setSetting, restoreSettings } from '../../helpers/worker';
import { checkoutAs, fillCart, orderMode } from '../../helpers/robots';
import { BRASOV } from '../../helpers/catalog';

// M9b: the cart shows both prices, checkout charges the chosen one, robots only with a Stripe test key,
// and the T1 "human courier nearby" guard only for human orders.
// 2 x Pizza = 1600. At 1500 m: human 150 (total 1750), sidewalk robot 75 (1675).
// At 3001 m: human 190 (1790), robot car 133 (1733).

const TEST_KEY = process.env.STRIPE_SECRET_KEY;

afterEach(async () => {
    process.env.STRIPE_SECRET_KEY = TEST_KEY;
    await restoreSettings();
});

function useLiveKey(): void {
    process.env.STRIPE_SECRET_KEY = 'sk_live_never_used';
}

describe('GET /cart: both quotes', () => {
    it('a short route: the human quote as before, plus a sidewalk robot at half the fee and 6 km/h', async () => {
        mockRoute(1_500, 180);
        const customer = await fillCart(await createShop());

        const res = await getCart(customer);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            delivery: { distanceM: 1_500, durationS: 180, feeMinor: 150 },
            totalMinor: 1_750,
            robotDelivery: { vehicle: 'robot', distanceM: 1_500, feeMinor: 75, etaS: 900 },
            robotTotalMinor: 1_675,
        });
    });

    it('beyond 2 km: a robot car at 30% off, car time x 1.25', async () => {
        mockRoute(3_001, 600);
        const customer = await fillCart(await createShop());

        const res = await getCart(customer);

        expect(res.body.robotDelivery).toEqual({ vehicle: 'robot_car', distanceM: 3_001, feeMinor: 133, etaS: 750 });
        expect(res.body.robotTotalMinor).toBe(1_733);
        expect(res.body.totalMinor).toBe(1_790);
    });

    it('robots off (not a Stripe test key): no robot quote, the human one is untouched', async () => {
        mockRoute(1_500);
        const customer = await fillCart(await createShop());
        useLiveKey();

        const res = await getCart(customer);

        expect(res.body).toMatchObject({ totalMinor: 1_750, robotDelivery: null, robotTotalMinor: null });
    });

    it('out of range: neither mode is offered', async () => {
        mockRoute(7_001);
        const customer = await fillCart(await createShop());

        const res = await getCart(customer);

        expect(res.body).toMatchObject({
            deliveryError: 'ADDRESS_OUT_OF_RANGE', delivery: null, totalMinor: null, robotDelivery: null, robotTotalMinor: null,
        });
    });
});

describe('POST /orders with deliveryMode', () => {
    beforeEach(() => {
        mockRoute(1_500);
    });

    it('robot: 201 at the robot price, stored on the order and shown in the order view', async () => {
        const customer = await fillCart(await createShop());

        const res = await checkoutAs(customer, 1_675, 'robot');

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ deliveryMode: 'robot', deliveryFeeMinor: 75, totalMinor: 1_675 });
        expect(await orderMode(res.body.id)).toEqual({ delivery_mode: 'robot', delivery_fee_minor: 75, total_minor: 1_675 });
        const view = await api().get(`/orders/${res.body.id}`).set(customer.headers);
        expect(view.body.deliveryMode).toBe('robot');
    });

    it('no deliveryMode (every caller before M9b): a human order at the normal price', async () => {
        const customer = await fillCart(await createShop());

        const res = await checkoutAs(customer, 1_750);

        expect(res.status).toBe(201);
        expect(res.body).toMatchObject({ deliveryMode: 'human', deliveryFeeMinor: 150, totalMinor: 1_750 });
    });

    it('robot with the HUMAN total: 409 PRICE_CHANGED with the robot total, nothing created', async () => {
        const customer = await fillCart(await createShop());

        const res = await checkoutAs(customer, 1_750, 'robot');

        expect(res.status).toBe(409);
        expect(res.body.error).toMatchObject({
            code: 'PRICE_CHANGED',
            details: { deliveryFeeMinor: 75, totalMinor: 1_675, deliveryMode: 'robot' },
        });
        expect(await countOrders()).toBe(0);
    });

    it('robot with a live key: 409 ROBOTS_UNAVAILABLE, nothing created, the cart is kept', async () => {
        const customer = await fillCart(await createShop());
        useLiveKey();

        const res = await checkoutAs(customer, 1_675, 'robot');

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('ROBOTS_UNAVAILABLE');
        expect(await countOrders()).toBe(0);
        expect((await getCart(customer)).body.items).toHaveLength(1);
    });

    it('a replay of a robot checkout returns the same order, even if robots were switched off meanwhile', async () => {
        const customer = await fillCart(await createShop());
        const first = await checkoutAs(customer, 1_675, 'robot', 'same-key');
        useLiveKey();

        const again = await checkoutAs(customer, 1_675, 'robot', 'same-key');

        expect(first.status).toBe(201);
        expect(again.status).toBe(200);
        expect(again.body.id).toBe(first.body.id);
        expect(await countOrders()).toBe(1);
    });

    it('an unknown mode: 400 VALIDATION_ERROR', async () => {
        const customer = await fillCart(await createShop());

        const res = await checkoutAs(customer, 1_750, 'drone');

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(await countOrders()).toBe(0);
    });
});

describe('the T1 guard (checkout_courier_check on) counts human couriers only', () => {
    beforeEach(async () => {
        mockRoute(1_500);
        await setSetting('checkout_courier_check', 1);
    });

    it('nobody online: human → 409 NO_COURIER_NEARBY, robot → 201', async () => {
        const shop = await createShop();
        const human = await fillCart(shop);
        const robot = await fillCart(shop);

        const humanRes = await checkoutAs(human, 1_750, 'human');
        const robotRes = await checkoutAs(robot, 1_675, 'robot');

        expect(humanRes.status).toBe(409);
        expect(humanRes.body.error.code).toBe('NO_COURIER_NEARBY');
        expect(robotRes.status).toBe(201);
    });

    it('only an online robot next to the restaurant: a human checkout still gets 409', async () => {
        await createCourier({ vehicle: 'robot', at: BRASOV });
        await createCourier({ vehicle: 'robot_car', at: BRASOV });
        const customer = await fillCart(await createShop());

        const res = await checkoutAs(customer, 1_750);

        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('NO_COURIER_NEARBY');
    });

    it('a human courier online nearby: the human checkout goes through', async () => {
        await createCourier({ vehicle: 'bike' });
        const customer = await fillCart(await createShop());

        const res = await checkoutAs(customer, 1_750);

        expect(res.status).toBe(201);
    });
});
