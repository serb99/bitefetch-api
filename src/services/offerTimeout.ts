import { pool } from '../database/pool';
import { logger } from '../logger';

const MAX_OFFERS_PER_PASS = 100;

type ExpiredOffer = { offerId: string; orderId: string; courierId: string };

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
         )
         UPDATE order_offers f
            SET status = 'expired',
                responded_at = now()
           FROM due
          WHERE f.id = due.id
      RETURNING f.id AS "offerId", f.order_id AS "orderId", f.courier_id AS "courierId"`,
      [MAX_OFFERS_PER_PASS]
    );

    for (const offer of rows) {
        logger.info(offer, 'Offer expired, nobody answered');
    }
    return rows.length;
}

export { expireTimedOutOffers };