import { pool } from './db';
import { createUser, type TestUser } from './users';
import { signAccessToken } from '../../src/utils/jwt';
import type { OpeningHours } from '../../src/utils/openingHours';

const SID = '00000000-0000-4000-8000-000000000000';

// Open every day except the single minute 23:59-00:00 (Europe/Bucharest): close is exclusive.
const ALWAYS_OPEN: OpeningHours = Object.fromEntries(
    ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]]),
);

// Brasov city centre; 0.009 degrees of latitude is about 1 km.
const BRASOV = { lat: 45.6427, lng: 25.5887 };

// requireAuth is stateless, so a signed token is enough (no login, no refresh family).
function tokenFor(user: { id: string; role: TestUser['role'] }): string {
    return signAccessToken({ id: user.id, role: user.role }, SID);
}

const bearer = (user: { id: string; role: TestUser['role'] }) => ({ Authorization: `Bearer ${tokenFor(user)}` });

async function createBrand(options: { name?: string; kind?: 'private' | 'chain'; osmBrandTag?: string } = {}): Promise<string> {
    const { rows } = await pool.query(
        `INSERT INTO brands (name, kind, osm_brand_tag) VALUES ($1, $2, $3) RETURNING id`,
        [options.name ?? 'Test Brand', options.kind ?? 'private', options.osmBrandTag ?? null],
    );
    return rows[0].id;
}

interface RestaurantOptions {
    brandId?: string;
    ownerId?: string | null;
    name?: string;
    lat?: number;
    lng?: number;
    osmId?: string;
    openingHours?: OpeningHours | null;
    isOpen?: boolean;
    pausedUntil?: Date | null;
    consecutiveTimeouts?: number;
}

async function createRestaurant(options: RestaurantOptions = {}): Promise<{ id: string; brandId: string }> {
    const brandId = options.brandId ?? await createBrand({ name: options.name });
    const ownerId = options.ownerId ?? null;
    // owned restaurants must have opening hours (restaurants_owned_have_hours)
    const hours = options.openingHours !== undefined ? options.openingHours : (ownerId ? ALWAYS_OPEN : null);
    const { rows } = await pool.query(
        `INSERT INTO restaurants (brand_id, owner_id, osm_id, name, address, lat, lng, opening_hours,
                                  is_open, paused_until, consecutive_timeouts)
         VALUES ($1, $2, $3, $4, 'Strada Republicii 1, Brasov', $5, $6, $7::jsonb, $8, $9, $10)
         RETURNING id`,
        [
            brandId, ownerId, options.osmId ?? null, options.name ?? 'Test Restaurant',
            options.lat ?? BRASOV.lat, options.lng ?? BRASOV.lng,
            hours === null ? null : JSON.stringify(hours),
            options.isOpen ?? true, options.pausedUntil ?? null, options.consecutiveTimeouts ?? 0,
        ],
    );
    return { id: rows[0].id, brandId };
}

interface OwnerWithRestaurant {
    owner: TestUser;
    restaurantId: string;
    brandId: string;
    headers: { Authorization: string };
}

// An active owner whose restaurant is already approved (owner_id set). There is no approval
// endpoint yet, so this skips the signup + admin approval flow.
async function createOwnerWithRestaurant(options: RestaurantOptions = {}): Promise<OwnerWithRestaurant> {
    const owner = await createUser({ role: 'restaurant_owner' });
    const { id, brandId } = await createRestaurant({ ...options, ownerId: owner.id });
    return { owner, restaurantId: id, brandId, headers: bearer(owner) };
}

interface MenuItemOptions {
    name?: string;
    priceMinor?: number;
    category?: string | null;
    sortOrder?: number;
    isActive?: boolean;
    description?: string | null;
}

async function createMenuItem(brandId: string, options: MenuItemOptions = {}): Promise<string> {
    const { rows } = await pool.query(
        `INSERT INTO menu_items (brand_id, name, description, price_minor, category, sort_order, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [
            brandId, options.name ?? 'Item', options.description ?? null, options.priceMinor ?? 1000,
            options.category === undefined ? 'Mains' : options.category,
            options.sortOrder ?? 0, options.isActive ?? true,
        ],
    );
    return rows[0].id;
}

async function setAvailability(restaurantId: string, menuItemId: string, available: boolean): Promise<void> {
    await pool.query(
        `INSERT INTO restaurant_item_availability (restaurant_id, menu_item_id, available) VALUES ($1, $2, $3)`,
        [restaurantId, menuItemId, available],
    );
}

export {
    ALWAYS_OPEN, BRASOV, tokenFor, bearer,
    createBrand, createRestaurant, createOwnerWithRestaurant, createMenuItem, setAvailability,
};
export type { OwnerWithRestaurant };
