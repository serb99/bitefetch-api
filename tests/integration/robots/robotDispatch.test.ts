import { pool } from '../../helpers/db';
import { mockRoute, createShop } from '../../helpers/customer';
import { BRASOV } from '../../helpers/catalog';
import {
    createCourier, moved, acceptOffer, setCourierOffline, passOfferDeadline,
    readyOrderAt, dispatchRow, offersFor, pendingOfferOf, allPendingOffers, profileRow, positionRows,
} from '../../helpers/dispatch';
import { readyRobotOrderAt, ageRobot } from '../../helpers/robots';
import { getTracking } from '../../helpers/tracking';
import { dispatchDueOrders } from '../../../src/services/dispatchService';
import { expireTimedOutOffers } from '../../../src/services/offerTimeout';
import { startRobotsForDueOrders, setIdleRobotsOffline } from '../../../src/services/robotDispatch';

// M9b: human orders only ever go to humans and robot orders only to robots (of the vehicle they were priced for);
// the worker starts one robot per robot order and parks idle robots.
// mockRoute(1500) → a sidewalk robot order; mockRoute(3001) → a robot car order. The shop is at BRASOV.

// A robot in the "garage": offline, no position (the start job gives it one at the restaurant)
function garageRobot(vehicle: 'robot' | 'robot_car' = 'robot') {
    return createCourier({ vehicle, online: false, at: null });
}

// S1 claims the ready order (→ searching) and searches once; with no robot online nobody is offered
async function searchingRobotOrder(shop?: Awaited<ReturnType<typeof createShop>>) {
    const order = await readyRobotOrderAt(shop ?? (await createShop()));
    await dispatchDueOrders();
    return order;
}

describe('the split: dispatch never mixes humans and robots', () => {
    it('a robot order is never offered to a human courier, even the only one next to the restaurant', async () => {
        mockRoute(1_500);
        const human = await createCourier({ vehicle: 'bike', at: BRASOV });
        const { orderId } = await readyRobotOrderAt(await createShop());

        await dispatchDueOrders();

        expect(await offersFor(orderId)).toEqual([]);
        expect(await pendingOfferOf(human.id)).toBeUndefined();
        expect((await dispatchRow(orderId)).dispatch_state).toBe('searching');
    });

    it('a human order is never offered to a robot', async () => {
        mockRoute(3_001);   // readyOrderAt pays the human TOTAL 1790, priced for 3001 m
        await createCourier({ vehicle: 'robot', at: BRASOV });
        await createCourier({ vehicle: 'robot_car', at: BRASOV });
        const { orderId } = await readyOrderAt(await createShop());

        await dispatchDueOrders();

        expect(await offersFor(orderId)).toEqual([]);
    });

    it('a short robot order goes to the sidewalk robot, not to a closer robot car', async () => {
        mockRoute(1_500);
        await createCourier({ vehicle: 'robot_car', at: BRASOV });
        const sidewalk = await createCourier({ vehicle: 'robot', at: moved(BRASOV, 500) });
        const { orderId } = await readyRobotOrderAt(await createShop());

        await dispatchDueOrders();

        const offers = await offersFor(orderId);
        expect(offers.map((o) => o.courier_id)).toEqual([sidewalk.id]);
    });

    it('a robot order beyond 2 km goes to a robot car, never to a sidewalk robot', async () => {
        mockRoute(3_001);
        await createCourier({ vehicle: 'robot', at: BRASOV });
        const car = await createCourier({ vehicle: 'robot_car', at: moved(BRASOV, 500) });
        const { orderId } = await readyRobotOrderAt(await createShop());

        await dispatchDueOrders();

        expect((await offersFor(orderId)).map((o) => o.courier_id)).toEqual([car.id]);
    });
});

describe('startRobotsForDueOrders (job robot-start)', () => {
    it('starts one robot at the restaurant and offers it the order at once', async () => {
        mockRoute(1_500);
        const robot = await garageRobot();
        const { orderId } = await searchingRobotOrder();

        const started = await startRobotsForDueOrders();

        expect(started).toBe(1);
        expect(await profileRow(robot.id)).toMatchObject({ availability: 'online', offline_reason: null, consecutive_missed_offers: 0 });
        const [position] = await positionRows(robot.id);
        expect(position).toMatchObject({ lat: BRASOV.lat, lng: BRASOV.lng });
        expect(Date.now() - position.received_at.getTime()).toBeLessThan(10_000);
        const offer = await pendingOfferOf(robot.id);
        expect(offer?.order_id).toBe(orderId);
    });

    it('the next pass starts nobody else: the order has its offer', async () => {
        mockRoute(1_500);
        await garageRobot();
        const second = await garageRobot();
        await searchingRobotOrder();
        await startRobotsForDueOrders();

        expect(await startRobotsForDueOrders()).toBe(0);
        expect((await profileRow(second.id)).availability).toBe('offline');
        expect(await allPendingOffers()).toHaveLength(1);
    });

    it('beyond 2 km it starts a robot car, and leaves the sidewalk robot in the garage', async () => {
        mockRoute(3_001);
        const sidewalk = await garageRobot('robot');
        const car = await garageRobot('robot_car');
        const { orderId } = await searchingRobotOrder();

        expect(await startRobotsForDueOrders()).toBe(1);

        expect((await profileRow(sidewalk.id)).availability).toBe('offline');
        expect((await pendingOfferOf(car.id))?.order_id).toBe(orderId);
    });

    it('never for a human order', async () => {
        mockRoute(3_001);   // readyOrderAt pays the human TOTAL 1790, priced for 3001 m
        const robot = await garageRobot('robot_car');
        await readyOrderAt(await createShop());
        await dispatchDueOrders();

        expect(await startRobotsForDueOrders()).toBe(0);
        expect((await profileRow(robot.id)).availability).toBe('offline');
    });

    it('a free robot of the right vehicle already online nearby: no new one (the dispatch offers that one)', async () => {
        mockRoute(1_500);
        const garage = await garageRobot();
        const { orderId } = await searchingRobotOrder();
        const waiting = await createCourier({ vehicle: 'robot', at: BRASOV });   // came online after the search

        expect(await startRobotsForDueOrders()).toBe(0);
        expect((await profileRow(garage.id)).availability).toBe('offline');

        await pool.query(`UPDATE orders SET next_search_at = now() WHERE id = $1`, [orderId]);
        await dispatchDueOrders();
        expect((await pendingOfferOf(waiting.id))?.order_id).toBe(orderId);
    });

    it('the fleet is busy (no free robot of that vehicle): nothing started, the order keeps searching', async () => {
        mockRoute(1_500);
        await garageRobot('robot_car');   // wrong vehicle for a short order
        const { orderId } = await searchingRobotOrder();

        expect(await startRobotsForDueOrders()).toBe(0);
        expect((await dispatchRow(orderId)).dispatch_state).toBe('searching');
        expect(await offersFor(orderId)).toEqual([]);
    });

    it('one robot per customer: a second robot order waits while the first has its robot; another customer does not', async () => {
        mockRoute(1_500);
        const shop = await createShop();
        const first = await garageRobot();
        await garageRobot();
        await garageRobot();
        const a = await searchingRobotOrder(shop);
        await startRobotsForDueOrders();
        const offer = await pendingOfferOf(first.id);
        expect((await acceptOffer(first, offer!.id)).status).toBe(200);

        // same customer, second robot order
        const b = await readyRobotOrderAt(shop, a.customer, 'key-2');
        await dispatchDueOrders();
        expect(await startRobotsForDueOrders()).toBe(0);
        expect(await offersFor(b.orderId)).toEqual([]);

        // a different customer at the same restaurant gets a robot
        const c = await searchingRobotOrder(shop);
        expect(await startRobotsForDueOrders()).toBe(1);
        expect(await offersFor(c.orderId)).toHaveLength(1);
    });

    it('never starts again a robot whose offer for this order expired (it would never be asked)', async () => {
        mockRoute(1_500);
        const robot = await garageRobot();
        const { orderId } = await searchingRobotOrder();
        await startRobotsForDueOrders();
        const offer = await pendingOfferOf(robot.id);
        await passOfferDeadline(offer!.id);
        await expireTimedOutOffers();
        await setCourierOffline(robot.id);   // e.g. the runner was down

        expect(await startRobotsForDueOrders()).toBe(0);
        expect((await profileRow(robot.id)).availability).toBe('offline');
        expect((await offersFor(orderId)).map((o) => o.status)).toEqual(['expired']);
    });

    it('once the robot accepts, the customer sees a robot courier in the tracking', async () => {
        mockRoute(1_500);
        const robot = await garageRobot();
        const { orderId, customer } = await searchingRobotOrder();
        await startRobotsForDueOrders();
        const offer = await pendingOfferOf(robot.id);
        await acceptOffer(robot, offer!.id);

        const res = await getTracking(orderId, customer.headers);

        expect(res.body.courier).toMatchObject({ vehicleType: 'robot', isRobot: true });
    });
});

describe('setIdleRobotsOffline (job robot-idle, robot_idle_offline_s 300)', () => {
    it('an online robot with nothing to do for 5 minutes goes offline', async () => {
        const robot = await createCourier({ vehicle: 'robot', at: BRASOV });
        await ageRobot(robot.id, 400);

        expect(await setIdleRobotsOffline()).toBe(1);
        expect((await profileRow(robot.id)).availability).toBe('offline');
    });

    it('a robot started a minute ago stays online', async () => {
        const robot = await createCourier({ vehicle: 'robot', at: BRASOV, wentOnlineAgoS: 60 });

        expect(await setIdleRobotsOffline()).toBe(0);
        expect((await profileRow(robot.id)).availability).toBe('online');
    });

    it('a robot with an offer in the last 5 minutes stays online', async () => {
        mockRoute(1_500);
        const robot = await createCourier({ vehicle: 'robot', at: BRASOV });
        await readyRobotOrderAt(await createShop());
        await dispatchDueOrders();
        await pool.query(`UPDATE courier_profiles SET went_online_at = now() - interval '400 seconds' WHERE user_id = $1`, [robot.id]);

        expect(await setIdleRobotsOffline()).toBe(0);   // a pending offer
        const offer = await pendingOfferOf(robot.id);
        await passOfferDeadline(offer!.id);
        await expireTimedOutOffers();
        expect(await setIdleRobotsOffline()).toBe(0);   // the offer was a minute ago
        expect((await profileRow(robot.id)).availability).toBe('online');
    });

    it('a robot on a delivery is never touched, however old', async () => {
        mockRoute(1_500);
        const robot = await createCourier({ vehicle: 'robot', at: BRASOV });
        await readyRobotOrderAt(await createShop());
        await dispatchDueOrders();
        const offer = await pendingOfferOf(robot.id);
        await acceptOffer(robot, offer!.id);
        await ageRobot(robot.id, 4_000);

        expect(await setIdleRobotsOffline()).toBe(0);
        expect((await profileRow(robot.id)).availability).toBe('online');
    });

    it('human couriers are never touched', async () => {
        const human = await createCourier({ vehicle: 'bike', wentOnlineAgoS: 4_000 });

        expect(await setIdleRobotsOffline()).toBe(0);
        expect((await profileRow(human.id)).availability).toBe('online');
    });
});
