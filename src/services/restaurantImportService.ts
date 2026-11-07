import type { PoolClient } from 'pg';
import { AppError } from '../errors/AppError';
import type { OsmPlace } from './osmClient';
import type { ManualRestaurantInput } from '../schemas/signupSchema'; 

type ImportedRestaurant = { id: string; brandId: string };

// the places we got from OSM are kept in the cache; look the chosen one up there
async function findCachedPlace(client: PoolClient, osmId: string): Promise<OsmPlace | null> {
    const { rows } = await client.query<{ elem: OsmPlace }>(
        `SELECT elem
            FROM osm_search_cache c,
                jsonb_array_elements(c.results) AS elem
          WHERE c.query_key LIKE 'restaurant|%'
            AND c.expires_at > now()
            AND elem->>'osmId' = $1
          LIMIT 1`,
          [osmId],
    );
    return rows[0]?.elem ?? null;
}

async function pickBrandId(client: PoolClient, place: OsmPlace, name: string): Promise<string> {
    // a chain we already manage?
    if (place.brand) {
          const chain = await client.query<{ id: string }>(
              `SELECT id FROM brands WHERE kind = 'chain' AND osm_brand_tag = $1`,
              [place.brand],
          );
          if (chain.rows[0]) {
              return chain.rows[0].id;
          }
      }

    // otherwise an independent restaurant: its own private brand
    const created = await client.query<{ id: string }>(
      `INSERT INTO brands (name, kind) VALUES ($1, 'private') RETURNING id`,
      [name]
    );
    return created.rows[0].id;
}

// must run inside a transaction opened by the caller (BEGIN ... COMMIT)
async function importOsmPlace(client: PoolClient, osmId: string): Promise<ImportedRestaurant> {
    // one import of this place at a time; the lock is released at COMMIT or ROLLBACK
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [osmId]);

    const existing = await client.query<{ id: string; brand_id: string; owner_id: string | null }>(
      `SELECT id, brand_id, owner_id FROM restaurants WHERE osm_id = $1`,
      [osmId]
    );
    const found = existing.rows[0];
    if (found) {
          if (found.owner_id !== null) {
              throw new AppError(409, 'RESTAURANT_ALREADY_CLAIMED', 'This restaurant already has an owner');
          }
          return { id: found.id, brandId: found.brand_id };
    }

    const place = await findCachedPlace(client, osmId);
    if (!place) {
          throw new AppError(404, 'PLACE_NOT_FOUND', 'Search for the restaurant again and pick it from the list');
    }

    // keep the values inside the column sizes (name 200, address 300, phone 32)
    const name = (place.name ?? place.displayName.split(',')[0]).slice(0, 200);
    const address = place.address ? place.address.slice(0, 300) : null;
    const phone = place.phone && place.phone.length <= 32 ? place.phone : null;

    const brandId = await pickBrandId(client, place, name);

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO restaurants (brand_id, osm_id, name, address, lat, lng, phone, osm_synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now())
       RETURNING id`,
       [brandId, osmId, name, address, place.lat, place.lng, phone]
    );

    return { id: inserted.rows[0].id, brandId };
}

// a restaurant that is not in OSM: its own private brand, no osm_id
async function createManualRestaurant(
    client: PoolClient,
    data: ManualRestaurantInput,
): Promise<ImportedRestaurant> {
    const brand = await client.query<{ id: string }>(
        `INSERT INTO brands (name, kind) VALUES ($1, 'private') RETURNING id`,
        [data.name]
    );
    const brandId = brand.rows[0].id;

    const restaurant = await client.query<{ id: string }>(
        `INSERT INTO restaurants (brand_id, name, address, lat, lng, phone)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
         [brandId, data.name, data.address, data.lat, data.lng, data.phone ?? null]
    );

    return { id: restaurant.rows[0].id, brandId };
}

export { importOsmPlace, createManualRestaurant };
export type { ImportedRestaurant };