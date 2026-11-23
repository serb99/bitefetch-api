import { api } from '../../helpers/http';
import { pool } from '../../helpers/db';
import { BRASOV } from '../../helpers/catalog';
import { createCustomer, mockRoute } from '../../helpers/customer';
import { setUserStatus } from '../../helpers/users';
import { dispatchDueOrders } from '../../../src/services/dispatchService';
import {
    createCourier, courierWithoutProfile, moved, dispatchSettings, courierState, sendPosition, setOnline,
    readyOrder, offersFor, pendingOfferOf, profileRow, positionRows, setPosition,
} from '../../helpers/dispatch';

// M7: who may use the courier endpoints, position reporting, going online and offline.

beforeEach(() => {
    mockRoute(3001);
});

const COURIER_ROUTES: [method: 'get' | 'put' | 'post', path: string][] = [
    ['get', '/courier'],
    ['put', '/courier/position'],
    ['post', '/courier/availability'],
    ['get', '/courier/offers/current'],
    ['post', '/courier/offers/1/accept'],
    ['post', '/courier/offers/1/decline'],
    ['get', '/courier/orders/current'],
    ['post', '/courier/orders/1/pickup'],
    ['post', '/courier/orders/1/deliver'],
];

describe('access to /courier', () => {
    it.each(COURIER_ROUTES)('%s %s: 401 without a token', async (method, path) => {
        const res = await api()[method](path);
        expect(res.status).toBe(401);
    });

    it.each(COURIER_ROUTES)('%s %s: 403 FORBIDDEN for a customer', async (method, path) => {
        const customer = await createCustomer();
        const res = await api()[method](path).set(customer.headers);
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('FORBIDDEN');
    });

    it('403 NO_COURIER_PROFILE for a courier account without a profile (not approved)', async () => {
        const headers = await courierWithoutProfile();
        for (const res of [
            await api().get('/courier').set(headers),
            await api().put('/courier/position').set(headers).send({ ...BRASOV, recordedAt: new Date().toISOString() }),
            await api().post('/courier/availability').set(headers).send({ online: true }),
        ]) {
            expect(res.status).toBe(403);
            expect(res.body.error.code).toBe('NO_COURIER_PROFILE');
        }
    });

    it('403 ACCOUNT_NOT_ACTIVE for a suspended courier (the services lock the users row)', async () => {
        const courier = await createCourier({ online: false });
        await setUserStatus(courier.id, 'suspended');

        const res = await setOnline(courier, true);

        expect(res.status).toBe(403);
        expect(res.body.error).toMatchObject({ code: 'ACCOUNT_NOT_ACTIVE', details: { status: 'suspended' } });
        expect((await profileRow(courier.id)).availability).toBe('offline');
    });
});

describe('PUT /courier/position', () => {
    it('204, one row per courier, received_at is the server time', async () => {
        const courier = await createCourier({ at: null, online: false });
        const first = moved(BRASOV, 100);
        const second = moved(BRASOV, 200);

        expect((await sendPosition(courier, first, { accuracyM: 12.6, headingDeg: 359.6, speedMps: 4.2 })).status).toBe(204);
        // The device clock is an hour behind: stored for information, never used for freshness
        const res = await sendPosition(courier, second, { recordedAt: new Date(Date.now() - 3_600_000).toISOString() });
        expect(res.status).toBe(204);

        const rows = await positionRows(courier.id);
        expect(rows).toHaveLength(1);
        expect(rows[0].lat).toBeCloseTo(second.lat, 9);
        expect(rows[0].lng).toBeCloseTo(second.lng, 9);
        expect(Math.abs(rows[0].db_now.getTime() - rows[0].received_at.getTime())).toBeLessThan(5_000);
        expect(rows[0].received_at.getTime() - rows[0].recorded_at.getTime()).toBeGreaterThan(3_500_000);
    });

    it('rounds accuracy and heading (360 is north again)', async () => {
        const courier = await createCourier({ at: null, online: false });

        await sendPosition(courier, BRASOV, { accuracyM: 12.6, headingDeg: 359.6, speedMps: 4.2 });

        const [row] = await positionRows(courier.id);
        expect(row).toMatchObject({ accuracy_m: 13, heading_deg: 0, speed_mps: 4.2 });
    });

    it.each([
        ['latitude out of range', { lat: 91 }],
        ['longitude out of range', { lng: -181 }],
        ['speed over 100 m/s', { speedMps: 101 }],
        ['negative heading', { headingDeg: -1 }],
        ['an unknown field (strict body)', { altitude: 400 }],
        ['recordedAt without a time zone offset', { recordedAt: '2026-11-23T10:00:00' }],
        ['recordedAt missing', { recordedAt: undefined }],
    ])('400 VALIDATION_ERROR for %s', async (_name, change) => {
        const courier = await createCourier({ at: null, online: false });

        const res = await sendPosition(courier, BRASOV, change);

        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
        expect(await positionRows(courier.id)).toHaveLength(0);
    });
});

describe('GET /courier', () => {
    it('shows the state; positionFresh follows courier_fresh_position_s', async () => {
        const { courier_fresh_position_s: freshS } = await dispatchSettings();
        const courier = await createCourier({ vehicle: 'scooter', online: false, at: null });

        let res = await courierState(courier);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({
            vehicleType: 'scooter', availability: 'offline', offlineReason: 'manual',
            positionReceivedAt: null, positionFresh: false,
        });

        await setPosition(courier.id, BRASOV, freshS - 5);
        res = await courierState(courier);
        expect(res.body.positionFresh).toBe(true);

        await setPosition(courier.id, BRASOV, freshS + 5);
        res = await courierState(courier);
        expect(res.body.positionFresh).toBe(false);
    });
});

describe('POST /courier/availability', () => {
    it('online needs a fresh position: 409 POSITION_STALE without one', async () => {
        const { courier_fresh_position_s: freshS } = await dispatchSettings();
        const never = await createCourier({ online: false, at: null });
        const old = await createCourier({ online: false, positionAgeS: freshS + 5 });

        for (const courier of [never, old]) {
            const res = await setOnline(courier, true);
            expect(res.status).toBe(409);
            expect(res.body.error).toMatchObject({ code: 'POSITION_STALE', details: { maxAgeS: freshS } });
            expect((await profileRow(courier.id)).availability).toBe('offline');
        }
    });

    it('online with a fresh position: went_online_at set, missed offers reset, offline reason cleared', async () => {
        const courier = await createCourier({ online: false });
        await pool.query(`UPDATE courier_profiles SET consecutive_missed_offers = 1 WHERE user_id = $1`, [courier.id]);

        const res = await setOnline(courier, true);

        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ availability: 'online', offlineReason: null, positionFresh: true });
        const profile = await profileRow(courier.id);
        expect(profile).toMatchObject({ availability: 'online', offline_reason: null, consecutive_missed_offers: 0 });
        expect(profile.went_online_at).not.toBeNull();
    });

    it('a second "online" tap changes nothing (went_online_at stays)', async () => {
        const courier = await createCourier({ online: false });
        await setOnline(courier, true);
        const before = (await profileRow(courier.id)).went_online_at;

        const res = await setOnline(courier, true);

        expect(res.status).toBe(200);
        expect((await profileRow(courier.id)).went_online_at).toEqual(before);
    });

    it('offline: 200 with reason manual; a second tap is also 200', async () => {
        const courier = await createCourier();

        const first = await setOnline(courier, false);
        const second = await setOnline(courier, false);

        expect(first.status).toBe(200);
        expect(second.status).toBe(200);
        expect(second.body).toMatchObject({ availability: 'offline', offlineReason: 'manual' });
    });

    it('400 for a body without a boolean', async () => {
        const courier = await createCourier();
        const res = await api().post('/courier/availability').set(courier.headers).send({ online: 'yes' });
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('going offline with a pending offer releases it (went_offline) and the next courier is asked at once', async () => {
        const first = await createCourier({ at: moved(BRASOV, 200) });
        const second = await createCourier({ at: moved(BRASOV, 900) });
        const { orderId } = await readyOrder();
        await dispatchDueOrders();
        const offer = await pendingOfferOf(first.id);
        expect(offer?.order_id).toBe(orderId);

        const res = await setOnline(first, false);

        expect(res.status).toBe(200);
        const offers = await offersFor(orderId);
        expect(offers[0]).toMatchObject({ courier_id: first.id, status: 'declined', decline_reason: 'went_offline' });
        expect(offers[0].responded_at).not.toBeNull();
        // the kick after the commit: no timer needed
        expect(offers[1]).toMatchObject({ courier_id: second.id, status: 'pending' });
    });
});
