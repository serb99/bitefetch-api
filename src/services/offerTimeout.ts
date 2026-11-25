import { pool } from '../database/pool';
import { logger } from '../logger';

const MAX_OFFERS_PER_PASS = 100;
// Offline after 2 missed offers in a row. Any answer (accept or decline) resets the count.
const MISSED_OFFERS_LIMIT = 2;

type ExpiredOffer = { offerId: string; orderId: string; courierId: string; missedInRow: number; setOffline: boolean };

// Expires the offers nobody answered in time. One statement, so the offer expiry and the missed-offer count commit together:
// 1. due: pending offers past expires_at, locked (SKIP LOCKED: another worker or an accept has them).
// 2. expired: those offers → expired.
// 3. counted: their couriers get consecutive_missed_offers + 1; at the limit an online courier goes
//    offline with reason missed_offers. Never touches an active delivery: offers only go to idle couriers.
// Lock order: offers, then courier_profiles, the same direction as accept (user → order → offer → profile).
async function expireTimedOutOffers(): Promise<number> {
    const { rows } = await pool.query<ExpiredOffer>(
        `WITH due AS (
             SELECT id
               FROM order_offers
              WHERE status = 'pending'
                AND expires_at <= now()
              ORDER BY expires_at
              LIMIT $1
              FOR UPDATE SKIP LOCKED
         ), expired AS (
             UPDATE order_offers f
                SET status = 'expired',
                    responded_at = now()
               FROM due
              WHERE f.id = due.id
          RETURNING f.id, f.order_id, f.courier_id
         ), counted AS (
             UPDATE courier_profiles cp
                SET consecutive_missed_offers = cp.consecutive_missed_offers + 1,
                    availability = CASE
                        WHEN cp.availability = 'online' AND cp.consecutive_missed_offers + 1 >= $2 THEN 'offline'
                        ELSE cp.availability
                    END,
                    offline_reason = CASE
                        WHEN cp.availability = 'online' AND cp.consecutive_missed_offers + 1 >= $2 THEN 'missed_offers'
                        ELSE cp.offline_reason
                    END
               FROM expired e
              WHERE cp.user_id = e.courier_id
          RETURNING cp.user_id,
                    cp.consecutive_missed_offers AS missed,
                    (cp.availability = 'offline' AND cp.offline_reason = 'missed_offers'
                        AND cp.consecutive_missed_offers = $2) AS set_offline
         )
         SELECT e.id AS "offerId",
                e.order_id AS "orderId",
                e.courier_id AS "courierId",
                COALESCE(c.missed, 0) AS "missedInRow",
                COALESCE(c.set_offline, false) AS "setOffline"
           FROM expired e
           LEFT JOIN counted c ON c.user_id = e.courier_id`,
      [MAX_OFFERS_PER_PASS, MISSED_OFFERS_LIMIT]
    );

    for (const offer of rows) {
        logger.info(offer, 'Offer expired, nobody answered');
        if (offer.setOffline) {
            logger.info({ courierId: offer.courierId }, 'Courier set offline after missed offers');
        }
    }
    return rows.length;
}

// Any answer from the courier (accept or decline) starts the count again. Called inside their transaction.
const RESET_MISSED_OFFERS_SQL = `
    UPDATE courier_profiles
       SET consecutive_missed_offers = 0
     WHERE user_id = $1 AND consecutive_missed_offers > 0`;

export { expireTimedOutOffers, MISSED_OFFERS_LIMIT, RESET_MISSED_OFFERS_SQL };
