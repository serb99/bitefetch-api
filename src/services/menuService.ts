import { pool } from '../database/pool';
import { AppError } from '../errors/AppError';
import type { CreateMenuItemInput, UpdateMenuItemInput } from '../schemas/menuItemSchema';

type OwnerBrand = { restaurantId: string; brandId: string; kind: 'chain' | 'private' };

const MENU_ITEM_COLUMNS = `id, brand_id, name, description, price_minor, currency,
    category, sort_order, image_url, is_active, created_at, updated_at`;

type MenuItemRow = {
    id: string;
    brand_id: string;
    name: string;
    description: string | null;
    price_minor: number;
    currency: string;
    category: string | null;
    sort_order: number;
    image_url: string | null;
    is_active: boolean;
    created_at: Date;
    updated_at: Date;
};

type OwnerMenuItemRow = MenuItemRow & { available: boolean };

//body field -> database column. Only these can ever appear in the SET clause.
const COLUMN_BY_FIELD = {
    name: 'name',
    description: 'description',
    priceMinor: 'price_minor',
    category: 'category',
    sortOrder: 'sort_order',
    imageUrl: 'image_url',
    isActive: 'is_active',
} as const;

async function getOwnerBrand(ownerId: number | string): Promise<OwnerBrand> {
    const { rows } = await pool.query<{ restaurant_id: string; brand_id: string; kind: 'chain' | 'private' }>(
        `SELECT r.id AS restaurant_id, r.brand_id, b.kind FROM restaurants r
          JOIN brands b ON b.id = r.brand_id
          WHERE r.owner_id = $1`, [ownerId]
    );

    const row = rows[0];
    if (!row) {
        throw new AppError(403, 'NO_RESTAURANT', 'You do not own a restaurant');
    }
    return { restaurantId: row.restaurant_id, brandId: row.brand_id, kind: row.kind };
}

// the menu of a chain is edited by an admin, never by the owner of one location
async function getEditableBrandId(ownerId: number | string): Promise<string> {
    const { brandId, kind } = await getOwnerBrand(ownerId);
    if (kind !== 'private') {
        throw new AppError(403, 'BRAND_NOT_EDITABLE', 'The menu of a chain is managed by an admin');
    }
    return brandId;
}

async function createMenuItem(ownerId: number | string, input: CreateMenuItemInput): Promise<MenuItemRow> {
    const brandId = await getEditableBrandId(ownerId);

    const { rows } = await pool.query<MenuItemRow>(
        `INSERT INTO menu_items
            (brand_id, name, description, price_minor, currency, category, sort_order, image_url)
         VALUES ($1, $2, $3, $4, 'EUR', $5, $6, $7)
         RETURNING ${MENU_ITEM_COLUMNS}`,
        [
            brandId,
            input.name,
            input.description ?? null,
            input.priceMinor,
            input.category ?? null,
            input.sortOrder ?? 0,
            input.imageUrl ?? null,
        ],
    );

    return rows[0];
}

async function updateMenuItem(
    ownerId: string,
    itemId: string,
    input: UpdateMenuItemInput,
): Promise<MenuItemRow> {
    const brandId = await getEditableBrandId(ownerId);

    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [field, column] of Object.entries(COLUMN_BY_FIELD)){
        const value = input[field as keyof UpdateMenuItemInput];
        if (value !== undefined) {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
        }
    }

    // the schema's .refine guarantees at least one field, so sets is never empty
    values.push(itemId, brandId);

    const { rows } = await pool.query<MenuItemRow>(
        `UPDATE menu_items SET ${sets.join(', ')}
           WHERE id = $${values.length - 1} AND brand_id = $${values.length}
           RETURNING ${MENU_ITEM_COLUMNS}`,
        values
    );

    if (!rows[0]) {
        throw new AppError(404, 'MENU_ITEM_NOT_FOUND', 'Menu item not found');
    }
    return rows[0];
}

async function listOwnerMenu(ownerId: string): Promise<{ editable: boolean; items: OwnerMenuItemRow[] }> {
    const { restaurantId, brandId, kind } = await getOwnerBrand(ownerId);

    const { rows } = await pool.query<OwnerMenuItemRow>(
        `SELECT m.*, COALESCE(a.available, true) AS available
          FROM menu_items m
          LEFT JOIN restaurant_item_availability a
               ON a.menu_item_id = m.id AND a.restaurant_id = $2
          WHERE m.brand_id = $1 ORDER BY m.category NULLS LAST, m.sort_order, m.id`,
        [brandId, restaurantId]
    );

    return { editable: kind === 'private', items: rows };
}

async function setItemAvailability(
    ownerId: string,
    menuItemId: string,
    available: boolean
): Promise<{ menu_item_id: string; available: boolean }> {
    const { restaurantId, brandId } = await getOwnerBrand(ownerId);

    const { rows } = await pool.query<{ menu_item_id: string; available: boolean }>(
        `INSERT INTO restaurant_item_availability (restaurant_id, menu_item_id, available, updated_by)
         SELECT $1::bigint, m.id, $3::boolean, $4::bigint
           FROM menu_items m
          WHERE m.id = $2 AND m.brand_id = $5
         ON CONFLICT (restaurant_id, menu_item_id)
         DO UPDATE SET available = EXCLUDED.available, updated_by = EXCLUDED.updated_by
         RETURNING menu_item_id, available`,
         [restaurantId, menuItemId, available, ownerId, brandId]
    );

    if (!rows[0]) {
        throw new AppError(404, 'MENU_ITEM_NOT_FOUND', 'Menu item not found');
    }
    return rows[0];
}

export { createMenuItem, updateMenuItem, listOwnerMenu, setItemAvailability };