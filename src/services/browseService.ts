import { pool } from '../database/pool';
import { isOpenNow } from '../utils/openingHours';
import type { OpeningHours } from '../utils/openingHours';
import { AppError } from '../errors/AppError';

type MenuRestaurantRow = {
    id: string;
    brand_id: string;
    name: string;
    brand_name: string;
    address: string | null;
    opening_hours: OpeningHours | null;
    is_open: boolean;
    paused_until: Date | null;
};

type MenuRow = {
    id: string;
    name: string;
    description: string | null;
    price_minor: number;
    currency: string;
    category: string | null;
    image_url: string | null;
    available: boolean;
};

type NearbyRow = {
    id: string;
    name: string;
    brand_name: string;
    address: string | null;
    lat: number;
    lng: number;
    opening_hours: OpeningHours | null;
    is_open: boolean;
    paused_until: Date | null;
    distance_km: number;
};

function isOrderable(
    r: { is_open: boolean; paused_until: Date | null; opening_hours: OpeningHours | null },
    now: Date,
): boolean {
    return r.is_open && (r.paused_until === null || r.paused_until <= now) && isOpenNow(r.opening_hours, now);
}

async function listNearbyRestaurants(lat: number, lng: number, radiusKm: number) {
    // a box around the point, cheap to filter with the (lat, lng) index
    const latDelta = radiusKm / 111.32;
    const lngDelta = radiusKm / (111.32 * Math.cos((lat * Math.PI) / 180));

    const { rows } = await pool.query<NearbyRow>(
        `SELECT *
          FROM (
            SELECT r.id, r.name, b.name AS brand_name, r.address, r.lat, r.lng,
                   r.opening_hours, r.is_open, r.paused_until,
                   6371 * 2 * asin(sqrt(
                            power(sin(radians(r.lat - $1::float8) / 2), 2) +
                            cos(radians($1::float8)) * cos(radians(r.lat)) *
                            power(sin(radians(r.lng - $2::float8) / 2), 2)
                        )) AS distance_km
            FROM restaurants r
            JOIN brands b ON b.id = r.brand_id
            WHERE r.owner_id IS NOT NULL
                AND r.lat BETWEEN $3::float8 AND $4::float8
                AND r.lng BETWEEN $5::float8 AND $6::float8
          ) t
         WHERE t.distance_km <= $7::float8
         ORDER BY t.distance_km
         LIMIT 50`, 
         [lat, lng, lat - latDelta, lat + latDelta, lng - lngDelta, lng + lngDelta, radiusKm]
    );

    const now = new Date();
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        brandName: row.brand_name,
        address: row.address,
        lat: row.lat,
        lng: row.lng,
        distanceKm: Math.round(row.distance_km * 10) / 10,
        orderable: isOrderable(row, now)
    }));
}

async function getRestaurantMenu(restaurantId: string) {
    const found = await pool.query<MenuRestaurantRow>(
        `SELECT r.id, r.brand_id, r.name, b.name AS brand_name, r.address,
                r.opening_hours, r.is_open, r.paused_until
           FROM restaurants r
           JOIN brands b ON b.id = r.brand_id
          WHERE r.id = $1 AND r.owner_id IS NOT NULL`,
        [restaurantId],
    );

    const restaurant = found.rows[0];
    if (!restaurant) {
        throw new AppError(404, 'RESTAURANT_NOT_FOUND', 'Restaurant not found');
    }

    const { rows } = await pool.query<MenuRow>(
        `SELECT m.id, m.name, m.description, m.price_minor, m.currency, m.category, m.image_url,
                COALESCE(a.available, true) AS available
           FROM menu_items m
           LEFT JOIN restaurant_item_availability a
                  ON a.menu_item_id = m.id AND a.restaurant_id = $2
          WHERE m.brand_id = $1 AND m.is_active
          ORDER BY m.category NULLS LAST, m.sort_order, m.id`,
        [restaurant.brand_id, restaurant.id],
    );

    // rows arrive ordered by category, so the items of one category are next to each other
    const categories: { name: string; items: unknown[] }[] = [];
    for (const row of rows) {
        const name = row.category ?? 'Other';
        let group = categories[categories.length - 1];
        if (!group || group.name !== name) {
            group = { name, items: [] };
            categories.push(group);
        }
        group.items.push({
            id: row.id,
            name: row.name,
            description: row.description,
            priceMinor: row.price_minor,
            currency: row.currency,
            imageUrl: row.image_url,
            available: row.available,
        });
    }

    return {
        restaurant: {
            id: restaurant.id,
            name: restaurant.name,
            brandName: restaurant.brand_name,
            address: restaurant.address,
            openingHours: restaurant.opening_hours,
            orderable: isOrderable(restaurant, new Date()),
        },
        categories,
    };
}

export { listNearbyRestaurants, getRestaurantMenu };