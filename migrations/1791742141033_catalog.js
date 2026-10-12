/**
 * Migration 3: catalog.
 * Tables: brands, restaurants, menu_items, restaurant_item_availability, osm_search_cache.
 * Source of truth: docs/design/database/schema.dbml (group "catalog").
*/

exports.shorthands = undefined;

const id = { type: 'bigint', primaryKey: true, sequenceGenerated: { precedence: 'BY DEFAULT' } };

exports.up = (pgm) => {
  const now = () => ({ type: 'timestamptz', notNull: true, default: pgm.func('now()') });

  // A brand owns a menu. Chains are managed by admins; an independent restaurant gets a private brand.
  pgm.createTable('brands', {
    id,
    name: { type: 'varchar(200)', notNull: true },
    kind: { type: 'brand_kind', notNull: true },
    osm_brand_tag: { type: 'varchar(200)', unique: true }, // matches the OSM brand tag; null for private brands
    created_at: now(),
    updated_at: now(),
  });

  // A physical place that takes orders. owner_id stays NULL until an owner claims it on approval.
  pgm.createTable('restaurants', {
    id,
    brand_id: { type: 'bigint', notNull: true, references: 'brands', onDelete: 'RESTRICT' },
    owner_id: { type: 'bigint', unique: true, references: 'users', onDelete: 'RESTRICT' }, // one restaurant per owner
    osm_id: { type: 'varchar(40)', unique: true }, // e.g. 'node/123456'
    name: { type: 'varchar(200)', notNull: true },
    address: { type: 'varchar(300)' },
    lat: { type: 'float8', notNull: true },
    lng: { type: 'float8', notNull: true },
    phone: { type: 'varchar(32)' },
    opening_hours: { type: 'jsonb' }, // weekly schedule in Europe/Bucharest; null = not orderable
    is_open: { type: 'boolean', notNull: true, default: true },
    paused_until: { type: 'timestamptz' },
    consecutive_timeouts: { type: 'int', notNull: true, default: 0 },
    osm_synced_at: { type: 'timestamptz' },
    version: { type: 'int', notNull: true, default: 0 }, // optimistic lock
    created_at: now(),
    updated_at: now(),
  });
  pgm.createIndex('restaurants', 'brand_id', { name: 'restaurants_brand_idx' });

  // Brand-level menu. Orders keep their own snapshot of name and price.
  pgm.createTable('menu_items', {
    id,
    brand_id: { type: 'bigint', notNull: true, references: 'brands', onDelete: 'RESTRICT' },
    name: { type: 'varchar(200)', notNull: true },
    description: { type: 'text' },
    price_minor: { type: 'int', notNull: true },
    currency: { type: 'char(3)', notNull: true, default: 'EURO' },
    category: { type: 'varchar(100)' },
    sort_order: { type: 'int', notNull: true, default: 0 },
    image_url: { type: 'varchar(1000)' },
    is_active: { type: 'boolean', notNull: true, default: true }, // soft delete
    created_at: now(),
    updated_at: now(),
  });
  pgm.createIndex('menu_items', ['brand_id', 'is_active', 'category', 'sort_order'], { name: 'menu_items_menu_idx' });

  // Per-restaurant overrides of the brand menu. A missing row means "available".
  pgm.createTable(
    'restaurant_item_availability',
    {
      restaurant_id: { type: 'bigint', notNull: true, references: 'restaurants', onDelete: 'CASCADE' },
      menu_item_id: { type: 'bigint', notNull: true, references: 'menu_items', onDelete: 'CASCADE' },
      available: { type: 'boolean', notNull: true },
      updated_by: { type: 'bigint', references: 'users', onDelete: 'SET NULL' },
      updated_at: now(),
    },
    { constraints: { primaryKey: ['restaurant_id', 'menu_item_id'] } },
  );
  pgm.createIndex('restaurant_item_availability', 'menu_item_id', { name: 'restaurant_item_availability_item_idx' });

  // Cached OpenStreetMap search results.
  pgm.createTable('osm_search_cache', {
    id,
    query_key: { type: 'varchar(200)', notNull: true, unique: true }, // normalized: kind + text + rounded bbox
    query: { type: 'jsonb', notNull: true },
    results: { type: 'jsonb', notNull: true },
    fetched_at: now(),
    expires_at: { type: 'timestamptz', notNull: true },
  });
  pgm.createIndex('osm_search_cache', 'expires_at', { name: 'osm_search_cache_expiry_idx' });
};

exports.down = (pgm) => {
  pgm.dropTable('osm_search_cache');
  pgm.dropTable('restaurant_item_availability');
  pgm.dropTable('menu_items');
  pgm.dropTable('restaurants');
  pgm.dropTable('brands');
};