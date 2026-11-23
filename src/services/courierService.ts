import type { PoolClient } from 'pg';
import { pool } from '../database/pool';
import { withTransaction } from '../database/transaction';
import { AppError } from '../errors/AppError';
import { sessionEnded } from '../errors/authErrors';
import { getNumberSettings } from './settingsService';
import type { CourierPositionBody } from '../schemas/courierSchema';
import { dispatchOrderNow, dispatchWaitingOrdersNear } from './dispatchService';

type CourierState = {
    vehicleType: 'bike' | 'scooter' | 'car';
    availability: 'online' | 'offline';
    offlineReason: 'manual' | 'missed_offers' | 'no_position' | 'suspended' | null;
    wentOnlineAt: Date | null;
    positionReceivedAt: Date | null;
    positionFresh: boolean;
};

type OfferRef = { id: string; orderId: string };
type DeclineReason = 'too_far' | 'busy' | 'vehicle_unsuitable' | 'other' | 'went_offline';

// Approval creates the profile, so a courier without one cannot work
function noCourierProfile(): AppError {
    return new AppError(403, 'NO_COURIER_PROFILE', 'This account has no courier profile');
}

async function lockActiveCourier(client: PoolClient, courierId: string): Promise<void> {
    const { rows } = await client.query<{ status: string }>(
        `SELECT status FROM users WHERE id = $1 FOR NO KEY UPDATE`,
        [courierId]
    );
    const user = rows[0];
    if (!user) {
        throw sessionEnded();
    }
    if (user.status !== 'active') {
        throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Account is not active', { status: user.status });
    }
}

async function updatePosition(courierId: string, body: CourierPositionBody): Promise<void> {
    const result = await pool.query(
        `INSERT INTO courier_positions (courier_id, lat, lng, accuracy_m, heading_deg, speed_mps, recorded_at)
         SELECT cp.user_id, $2::float8, $3::float8, $4::int, $5::int, $6::float8, $7::timestamptz
           FROM courier_profiles cp
          WHERE cp.user_id = $1
         ON CONFLICT (courier_id) DO UPDATE SET
            lat = EXCLUDED.lat,
            lng = EXCLUDED.lng,
            accuracy_m = EXCLUDED.accuracy_m,
            heading_deg = EXCLUDED.heading_deg,
            speed_mps = EXCLUDED.speed_mps,
            recorded_at = EXCLUDED.recorded_at,
            received_at = now()`,
        [courierId, body.lat, body.lng, body.accuracyM ?? null, body.headingDeg ?? null, body.speedMps ?? null, body.recordedAt]
    );
    if (result.rowCount === 0) {
        throw noCourierProfile();
    }
}

async function getCourierState(courierId: string): Promise<CourierState> {
    const settings = await getNumberSettings(['courier_fresh_position_s'] as const);
    const { rows } = await pool.query<CourierState>(
        `SELECT cp.vehicle_type AS "vehicleType",
                cp.availability,
                cp.offline_reason AS "offlineReason",
                cp.went_online_at AS "wentOnlineAt",
                p.received_at AS "positionReceivedAt",
                COALESCE(p.received_at > now() - make_interval(secs => $2), false) AS "positionFresh"
           FROM courier_profiles cp
           LEFT JOIN courier_positions p ON p.courier_id = cp.user_id
          WHERE cp.user_id = $1`,
          [courierId, settings.courier_fresh_position_s]
    );
    if (!rows[0]) {
        throw noCourierProfile();
    }
    return rows[0];
}

async function getAvailability(client: PoolClient, courierId: string): Promise<CourierState['availability']> {
    const { rows } = await client.query<Pick<CourierState, 'availability'>>(
        `SELECT availability FROM courier_profiles WHERE user_id = $1`,
        [courierId]
    );
    if (!rows[0]) {
        throw noCourierProfile();
    }
    return rows[0].availability;
}

async function goOnline(courierId: string): Promise<void> {
    const settings = await getNumberSettings(['courier_fresh_position_s'] as const);
    const maxAgeS = settings.courier_fresh_position_s;

    await withTransaction(async (client) => {
        await lockActiveCourier(client, courierId);
        if ((await getAvailability(client, courierId)) === 'online') return;

        const result = await client.query(
            `UPDATE courier_profiles cp
                SET availability = 'online',
                    offline_reason = NULL,
                    went_online_at = now(),
                    consecutive_missed_offers = 0
                FROM courier_positions p
                WHERE cp.user_id = $1
                AND p.courier_id = cp.user_id
                AND p.received_at > now() - make_interval(secs => $2)`,
            [courierId, maxAgeS]
        );
        if (result.rowCount === 0) {
            throw new AppError(409, 'POSITION_STALE', 'Send your current position first', { maxAgeS });
        }
    }, `user:${courierId}`, 'courier went online');

    await dispatchWaitingOrdersNear(courierId);
}

async function closeOfferAsDeclined(client: PoolClient, offer: OfferRef, reason: DeclineReason | null): Promise<boolean> {
    const result = await client.query(
        `UPDATE order_offers
            SET status = 'declined',
                decline_reason = $2,
                responded_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [offer.id, reason]
    );
    if (result.rowCount === 0) {
        return false;
    }
    await client.query(
        `UPDATE orders
            SET next_search_at = now()
          WHERE id = $1
            AND status IN ('accepted', 'ready_for_pickup')
            AND dispatch_state IN ('searching', 'no_courier')`,
        [offer.orderId]
    );
    return true;
}

// Gives back the courier's pending offer (if any) and asks the next courier at once.
// Run AFTER "offline" was committed: from then on dispatch creates no new offer for this courier.
// Used by the manual "go offline" and by the auto-offline sweeper.
async function releasePendingOffer(courierId: string, actor: string): Promise<void> {
    const releasedOrderId = await withTransaction(async (client) => {
        await lockActiveCourier(client, courierId);
        
        if ((await getAvailability(client, courierId)) === 'online') return null;

        const { rows } = await client.query<OfferRef>(
            `SELECT id, order_id AS "orderId"
               FROM order_offers
              WHERE courier_id = $1 AND status = 'pending'`,
            [courierId]
        );
        const offer = rows[0];
        if (!offer) return null;

        await client.query(`SELECT 1 FROM orders WHERE id = $1 FOR UPDATE`, [offer.orderId]);
        const released = await closeOfferAsDeclined(client, offer, 'went_offline');
        return released ? offer.orderId : null;
    }, actor, 'offer released: courier went offline');

    // The next courier is asked now
    if (releasedOrderId) {
        await dispatchOrderNow(releasedOrderId);
    }
}

async function goOffline(courierId: string): Promise<void> {
    await withTransaction(async (client) => {
        await lockActiveCourier(client, courierId);
        if ((await getAvailability(client, courierId)) === 'offline') return;

        await client.query(
            `UPDATE courier_profiles
                SET availability = 'offline',
                    offline_reason = 'manual'
              WHERE user_id = $1`,
            [courierId]
        );
    }, `user:${courierId}`, 'courier went offline');

    // 2. Give back the offer that was open, if any. A retry runs this step again.
    await releasePendingOffer(courierId, `user:${courierId}`);
}

async function setAvailability(courierId: string, online: boolean): Promise<CourierState> {
    if (online) {
        await goOnline(courierId);
    } else {
        await goOffline(courierId);
    }
    return getCourierState(courierId);
}

export { 
    lockActiveCourier,
    closeOfferAsDeclined, 
    updatePosition, 
    getCourierState, 
    setAvailability,
    releasePendingOffer
};
export type { CourierState, OfferRef, DeclineReason };