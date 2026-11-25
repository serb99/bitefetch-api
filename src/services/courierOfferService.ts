import type { PoolClient } from 'pg';
import { pool } from '../database/pool';
import { withTransaction } from '../database/transaction';
import { AppError } from '../errors/AppError';
import { lockActiveCourier, closeOfferAsDeclined, type OfferRef, type DeclineReason } from './courierService';
import { dispatchOrderNow } from './dispatchService';
import { RESET_MISSED_OFFERS_SQL } from './offerTimeout';
import type { DeclineOfferBody } from '../schemas/courierSchema';
import type { OrderStatus } from './orderTransition';
import { getCurrentOrder, getRouteToRestaurant, type CourierOrder } from './courierOrderService';
import type { Route } from './osrmClient';

type OfferStatus = 'pending' | 'accepted' | 'declined' | 'expired' | 'withdrawn';

// What a courier may know before saying yes
type CurrentOffer = {
    id: string;
    expiresAt: Date;
    secondsLeft: number;
    restaurant: { name: string; address: string | null; lat: number; lng: number };
    distanceToRestaurantM: number | null; // straight line, when the offer was made
    deliveryDistanceM: number;            // by road, restaurant to customer
    itemCount: number;
    estimatedReadyAt: Date;
    readyAt: Date | null;
};

type DeclinedOffer = { id: string; status: OfferStatus; declineReason: DeclineReason | null };
type AcceptedOffer = { offerId: string; orderId: string; orderCode: string; status: OrderStatus; version: number };
type AcceptResult = AcceptedOffer & { order: CourierOrder | null; route: Route | null };

async function getCurrentOffer(courierId: string): Promise<CurrentOffer | null> {
    const { rows } = await pool.query<CurrentOffer>(
        `SELECT f.id,
                f.expires_at AS "expiresAt",
                floor(extract(epoch FROM f.expires_at - now()))::int AS "secondsLeft",
                json_build_object('name', r.name, 'address', r.address, 'lat', r.lat, 'lng', r.lng) AS restaurant,
                f.distance_m AS "distanceToRestaurantM",
                o.delivery_distance_m AS "deliveryDistanceM",
                (SELECT COALESCE(sum(oi.quantity), 0)::int FROM order_items oi WHERE oi.order_id = o.id) AS "itemCount",
                o.estimated_ready_at AS "estimatedReadyAt",
                o.ready_at AS "readyAt"
           FROM order_offers f
           JOIN orders o ON o.id = f.order_id
           JOIN restaurants r ON r.id = o.restaurant_id
          WHERE f.courier_id = $1
            AND f.status = 'pending'
            AND f.expires_at > now()`,
        [courierId]
    );
    return rows[0] ?? null;
}

function offerNotFound(): AppError {
    return new AppError(404, 'OFFER_NOT_FOUND', 'Offer not found');
}

function offerClosed(offerStatus: OfferStatus): AppError {
    return new AppError(409, 'OFFER_CLOSED', 'This offer is no longer open', { offerStatus });
}

async function lockOfferOrder(client: PoolClient, courierId: string, offerId: string): Promise<OfferRef> {
    await lockActiveCourier(client, courierId);

    const { rows } = await client.query<OfferRef>(
        `SELECT id, order_id AS "orderId"
           FROM order_offers
          WHERE id = $1 AND courier_id = $2`,
        [offerId, courierId]
    );
    const offer = rows[0];
    if (!offer) {
        throw offerNotFound();
    }
    await client.query(`SELECT 1 FROM orders WHERE id = $1 FOR UPDATE`, [offer.orderId]);
    return offer;
}

async function declineOffer(courierId: string, offerId: string, body: DeclineOfferBody): Promise<DeclinedOffer> {
    const { declined, orderToDispatch } = await withTransaction(async (client) => {
        const offer = await lockOfferOrder(client, courierId, offerId);
        const changed = await closeOfferAsDeclined(client, offer, body.reason ?? null);

        const { rows } = await client.query<DeclinedOffer>(
            `SELECT id, status, decline_reason AS "declineReason"
               FROM order_offers
              WHERE id = $1`,
            [offer.id]
        );
        const stored = rows[0];
        if (stored.status !== 'declined') {
            throw offerClosed(stored.status);
        }
        // An answer: the "missed offers in a row" count starts again
        await client.query(RESET_MISSED_OFFERS_SQL, [courierId]);
        return { declined: stored, orderToDispatch: changed ? offer.orderId : null };
    }, `user:${courierId}`, 'offer declined');

    if (orderToDispatch) {
        await dispatchOrderNow(orderToDispatch);
    }
    return declined;
}

async function acceptOffer(courierId: string, offerId: string): Promise<AcceptResult>{
    const accepted = await withTransaction(async (client) => {
        const offer = await lockOfferOrder(client, courierId, offerId);

        const { rows: offers } = await client.query<{ status: OfferStatus; overdue: boolean }>(
            `SELECT status, expires_at <= now() AS overdue
               FROM order_offers
              WHERE id = $1
              FOR UPDATE`,
            [offer.id]
        );
        const { status, overdue } = offers[0];

        if (status === 'pending' && overdue) {
            throw offerClosed('expired');
        }
        if (status !== 'pending' && status !== 'accepted') {
            throw offerClosed(status);
        }
        if (status === 'pending') {
             await client.query(
                `UPDATE order_offers
                    SET status = 'accepted',
                        responded_at = now()
                  WHERE id = $1`,
                [offer.id]
            );
            await client.query(
                `UPDATE orders
                    SET courier_id = $2,
                        dispatch_state = 'assigned',
                        version = version + 1
                  WHERE id = $1
                    AND courier_id IS NULL
                    AND status IN ('accepted', 'ready_for_pickup')
                    AND dispatch_state IN ('searching', 'no_courier')`,
                [offer.orderId, courierId]
            );
            await client.query(
                `UPDATE order_incidents
                    SET resolved_at = now(),
                        resolution_note = 'a courier accepted'
                  WHERE order_id = $1
                    AND type = 'no_courier'
                    AND resolved_at IS NULL`,
                [offer.orderId]
            );
            // An answer: the "missed offers in a row" count starts again
            await client.query(RESET_MISSED_OFFERS_SQL, [courierId]);
        }

        const { rows: orders } = await client.query<AcceptedOffer & { courierId: string | null }>(
            `SELECT $2::bigint AS "offerId",
                    id AS "orderId",
                    order_code AS "orderCode",
                    status,
                    version,
                    courier_id AS "courierId"
               FROM orders
              WHERE id = $1`,
            [offer.orderId, offer.id]
        );
        const { courierId: assignedTo, ...accepted } = orders[0];

        if (assignedTo !== courierId) {
            throw new AppError(409, 'ORDER_STATUS_CHANGED', 'The order changed in the meantime', { status: accepted.status });
        }
        return accepted;
    }, `user:${courierId}`, 'offer accepted');

    const current = await getCurrentOrder(courierId);
    const order = current?.id === accepted.orderId ? current : null;
    const route = order ? await getRouteToRestaurant(courierId, order) : null;
    return { ...accepted, order, route };
}

export { getCurrentOffer, declineOffer, acceptOffer };
export type { CurrentOffer, DeclinedOffer,  AcceptedOffer, AcceptResult };