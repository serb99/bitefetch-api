import { BRASOV } from '../../helpers/catalog';
import { mockRoute } from '../../helpers/customer';
import { dispatchDueOrders } from '../../../src/services/dispatchService';
import { getNumberSettings } from '../../../src/services/settingsService';
import { setSilentCouriersOffline } from '../../../src/services/courierAutoOffline';
import {
    acceptOffer, acceptedDueOrder, assignedOrder, createCourier, moved, offersFor, pendingOfferOf, pickedUpOrder,
    profileRow, readyOrder, setOnline, setPosition, type Courier,
} from '../../helpers/dispatch';

// M8 auto-offline (R10): an online, active courier without a position for courier_no_position_offline_s goes
// offline ('no_position') and gives back a pending offer. A courier with an active delivery is never touched.

let offlineAfterS: number;

beforeEach(async () => {
    mockRoute(3001);
    offlineAfterS = (await getNumberSettings(['courier_no_position_offline_s'] as const)).courier_no_position_offline_s;
});

describe('who goes offline', () => {
    it('position older than the setting: offline with reason no_position', async () => {
        const courier = await createCourier({ positionAgeS: offlineAfterS + 1 });

        expect(await setSilentCouriersOffline()).toBe(1);

        expect(await profileRow(courier.id)).toMatchObject({ availability: 'offline', offline_reason: 'no_position' });
    });

    it('no position row at all: offline', async () => {
        const courier = await createCourier({ at: null });

        expect(await setSilentCouriersOffline()).toBe(1);

        expect((await profileRow(courier.id)).availability).toBe('offline');
    });

    it('position younger than the setting: stays online', async () => {
        const courier = await createCourier({ positionAgeS: offlineAfterS - 20 });

        expect(await setSilentCouriersOffline()).toBe(0);

        expect((await profileRow(courier.id)).availability).toBe('online');
    });

    it('already offline (manual) or suspended: untouched', async () => {
        const offline = await createCourier({ online: false, positionAgeS: offlineAfterS + 60 });
        const suspended = await createCourier({ status: 'suspended', positionAgeS: offlineAfterS + 60 });

        expect(await setSilentCouriersOffline()).toBe(0);

        expect(await profileRow(offline.id)).toMatchObject({ availability: 'offline', offline_reason: 'manual' });
        expect((await profileRow(suspended.id)).availability).toBe('online');
    });
});

describe('a courier with an active delivery is never touched (a tunnel mid-delivery)', () => {
    const activeOrders: [string, (courier: Courier) => Promise<unknown>][] = [
        ['accepted', async (courier) => {
            await acceptedDueOrder();
            await dispatchDueOrders();
            const res = await acceptOffer(courier, (await pendingOfferOf(courier.id))!.id);
            if (res.status !== 200) throw new Error(`accept failed: ${res.status}`);
        }],
        ['ready_for_pickup', (courier) => assignedOrder(courier)],
        ['picked_up', (courier) => pickedUpOrder(courier)],
    ];

    it.each(activeOrders)('%s with a silent phone: stays online', async (_status, giveOrder) => {
        const courier = await createCourier();
        await giveOrder(courier);
        await setPosition(courier.id, BRASOV, offlineAfterS + 300);

        expect(await setSilentCouriersOffline()).toBe(0);

        expect((await profileRow(courier.id)).availability).toBe('online');
    });
});

describe('the pending offer', () => {
    // courier1 is nearest and gets the offer; courier2 (2 km) is next in line.
    async function offerToSilentCourier() {
        const courier1 = await createCourier();
        const courier2 = await createCourier({ at: moved(BRASOV, 2_000) });
        const { orderId } = await readyOrder();
        await dispatchDueOrders();
        expect((await pendingOfferOf(courier1.id))?.order_id).toBe(orderId);
        await setPosition(courier1.id, moved(BRASOV, 300), offlineAfterS + 1); // courier1's phone died
        return { courier1, courier2, orderId };
    }

    it('is declined (went_offline) and the next courier gets the order in the same pass', async () => {
        const { courier1, courier2, orderId } = await offerToSilentCourier();

        expect(await setSilentCouriersOffline()).toBe(1);

        const offers = await offersFor(orderId);
        expect(offers.map((o) => [o.courier_id, o.status, o.decline_reason])).toEqual([
            [courier1.id, 'declined', 'went_offline'],
            [courier2.id, 'pending', null],
        ]);
    });

    it('two passes at the same time: one offline, the offer released once', async () => {
        const { courier1, orderId } = await offerToSilentCourier();

        const counts = await Promise.all([setSilentCouriersOffline(), setSilentCouriersOffline()]);

        expect(counts[0] + counts[1]).toBe(1);
        expect(await profileRow(courier1.id)).toMatchObject({ availability: 'offline', offline_reason: 'no_position' });
        const offers = await offersFor(orderId);
        expect(offers.filter((o) => o.status === 'declined')).toHaveLength(1);
        expect(offers.filter((o) => o.status === 'pending')).toHaveLength(1);
    });
});

it('the manual "go offline" still works as before (reason manual, offer released)', async () => {
    const courier1 = await createCourier();
    const courier2 = await createCourier({ at: moved(BRASOV, 2_000) });
    const { orderId } = await readyOrder();
    await dispatchDueOrders();

    const res = await setOnline(courier1, false);

    expect(res.status).toBe(200);
    expect(await profileRow(courier1.id)).toMatchObject({ availability: 'offline', offline_reason: 'manual' });
    expect((await pendingOfferOf(courier2.id))?.order_id).toBe(orderId);
});
