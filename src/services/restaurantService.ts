import { pool } from '../database/pool';
import { AppError } from '../errors/AppError';
import type { UpdateRestaurantInput } from '../schemas/restaurantSchema';

const RESTAURANT_COLUMNS = `id, brand_id, name, address, lat, lng, phone,
    opening_hours, is_open, paused_until, version`;

type RestaurantRow = {
    id: string;
    brand_id: string;
    name: string;
    address: string | null;
    lat: number;
    lng: number;
    phone: string | null;
    opening_hours: Record<string, [string, string][]> | null;
    is_open: boolean;
    paused_until: Date | null;
    version: number;
};

// body field -> database column. Only these can appear in the SET clause.
const COLUMN_BY_FIELD = {
    name: 'name',
    address: 'address',
    phone: 'phone',
    openingHours: 'opening_hours',
    isOpen: 'is_open',
    pausedUntil: 'paused_until',
} as const;

// after this many consecutive accept timeouts the worker pauses the restaurant
const AUTO_PAUSE_TIMEOUTS = 2;

async function getOwnerRestaurant(ownerId: string): Promise<RestaurantRow> {
    const { rows } = await pool.query<RestaurantRow>(
        `SELECT ${RESTAURANT_COLUMNS}
           FROM restaurants
          WHERE owner_id = $1`,
          [ownerId]
    );

    if (!rows[0]){
        throw new AppError(403, 'NO_RESTAURANT', 'You do not own a restaurant');
    }
    return rows[0];
}

async function updateOwnerRestaurant(
    ownerId: string,
    input: UpdateRestaurantInput,
): Promise<RestaurantRow> {
    await getOwnerRestaurant(ownerId); // throws 403 NO_RESTAURANT when the user owns nothing

    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [field, column] of Object.entries(COLUMN_BY_FIELD)) {
        const value = input[field as keyof UpdateRestaurantInput];
        if (value !== undefined) {
            const isJson = field === 'openingHours';
            values.push(isJson ? JSON.stringify(value) : value);
            sets.push(`${column} = $${values.length}${isJson ? '::jsonb' : ''}`);
        }
    }
    sets.push('version = version + 1');
    values.push(ownerId);
    let where = `owner_id = $${values.length}`;

    // the owner may not touch the pause while the restaurant is auto-paused
    if (input.pausedUntil !== undefined) {
        values.push(AUTO_PAUSE_TIMEOUTS);
        where += ` AND NOT (consecutive_timeouts >= $${values.length}
                            AND paused_until IS NOT NULL
                            AND paused_until > now())`;
    }

    const { rows } = await pool.query<RestaurantRow>(
        `UPDATE restaurants
            SET ${sets.join(', ')}
          WHERE ${where}
      RETURNING ${RESTAURANT_COLUMNS}`,
        values,
    );

    if (!rows[0]) {
        throw new AppError(409, 'RESTAURANT_AUTO_PAUSED', 'The restaurant was paused automatically; contact an admin');
    }
    return rows[0];
}

export { getOwnerRestaurant, updateOwnerRestaurant };