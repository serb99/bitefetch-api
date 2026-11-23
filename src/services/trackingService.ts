import { pool } from '../database/pool';
import { AppError } from '../errors/AppError';
import { getNumberSettings } from './settingsService';
import type { VehicleType } from '../utils/deliveryEta';
import { getRouteOrNull } from './routeService';
import type { Route } from './osrmClient';

type Leg = 'to_restaurant' | 'to_customer';

type CourierPosition = {
    lat: number;
    lng: number;
    headingDeg: number | null;
    ageS: number;    
    stale: boolean;    
};

type OrderTracking = {
    orderId: string;
    status: string;
    leg: Leg | null;
    restaurant: { name: string; lat: number; lng: number };
    destination: { lat: number; lng: number };
    courier: {
        firstName: string;
        vehicleType: VehicleType;
        position: CourierPosition | null;   // null: the courier never sent one
    } | null;
};

type TrackingRow = {
    status: string;
    restaurant: OrderTracking['restaurant'];
    destination: OrderTracking['destination'];
    courierFirstName: string | null;
    vehicleType: VehicleType | null;
    position: CourierPosition | null;
};

type OrderRoute = {
    leg: Leg | null;
    route: Route | null;   // null: no leg, no courier position yet, or OSRM failed / too slow
};

// Polled every 3 s by the order page
async function getOrderTracking(customerId: string, orderId: string): Promise<OrderTracking> {
    const settings = await getNumberSettings(['courier_fresh_position_s'] as const);

    const { rows } = await pool.query<TrackingRow>(
        `SELECT o.status,
                json_build_object('name', r.name, 'lat', r.lat, 'lng', r.lng) AS restaurant,
                json_build_object('lat', o.delivery_lat, 'lng', o.delivery_lng) AS destination,
                split_part(cu.full_name, ' ', 1) AS "courierFirstName",
                cp.vehicle_type AS "vehicleType",
                CASE WHEN p.courier_id IS NOT NULL THEN json_build_object(
                    'lat', p.lat,
                    'lng', p.lng,
                    'headingDeg', p.heading_deg,
                    'ageS', floor(extract(epoch FROM now() - p.received_at))::int,
                    'stale', p.received_at <= now() - make_interval(secs => $3)
                ) END AS position
           FROM orders o
           JOIN restaurants r ON r.id = o.restaurant_id
           LEFT JOIN users cu ON cu.id = o.courier_id
                             AND o.status IN ('accepted', 'ready_for_pickup', 'picked_up')
           LEFT JOIN courier_profiles cp ON cp.user_id = cu.id
           LEFT JOIN courier_positions p ON p.courier_id = cu.id
          WHERE o.id = $1 AND o.customer_id = $2`,
        [orderId, customerId, settings.courier_fresh_position_s]
    );
    const row = rows[0];
    if (!row) {
        throw new AppError(404, 'ORDER_NOT_FOUND', 'Order not found');
    }

    const hasCourier = row.courierFirstName !== null && row.vehicleType !== null;
    return {
        orderId,
        status: row.status,
        leg: hasCourier ? (row.status === 'picked_up' ? 'to_customer' : 'to_restaurant') : null,
        restaurant: row.restaurant,
        destination: row.destination,
        courier: hasCourier
            ? { firstName: row.courierFirstName!, vehicleType: row.vehicleType!, position: row.position }
            : null
    };
}

// The road for the current leg. Called once per leg by the web
// leg 1 starts at the courier's position, so every call is a new OSRM request.
async function getOrderRoute(customerId: string, orderId: string): Promise<OrderRoute> {
    const tracking = await getOrderTracking(customerId, orderId);

    if (tracking.leg === 'to_customer') {
        return { leg: tracking.leg, route: await getRouteOrNull(tracking.restaurant, tracking.destination) };
    }
    if (tracking.leg === 'to_restaurant') {
        const position = tracking.courier?.position;
        if (!position) {
            return { leg: tracking.leg, route: null };
        }
        return { leg: tracking.leg, route: await getRouteOrNull(position, tracking.restaurant) };
    }
    return { leg: null, route: null };
}

export { getOrderTracking, getOrderRoute };
export type { OrderTracking, OrderRoute, Leg };