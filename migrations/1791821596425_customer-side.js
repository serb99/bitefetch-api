/**
 * Migration 5: customer side.
 * Tables: delivery_addresses, carts, cart_items.
 * Source of truth: docs/design/database/schema.dbml (group "customer_side").
 */

exports.shorthands = undefined;

const id = { type: 'bigint', primaryKey: true, sequenceGenerated: { precedence: 'BY DEFAULT' } };

exports.up = (pgm) => {
  const now = () => ({ type: 'timestamptz', notNull: true, default: pgm.func('now()') });

  // Saved addresses. Orders keep their own snapshot, so these rows can be hard-deleted.
  pgm.createTable('delivery_addresses', {
    id,
    user_id: { type: 'bigint', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
    label: { type: 'varchar(50)' }, // "Home", "Work"
    street: { type: 'varchar(300)', notNull: true },
    details: { type: 'varchar(300)' }, // apartment, floor, intercom
    city: { type: 'varchar(100)', notNull: true },
    lat: { type: 'float8', notNull: true },
    lng: { type: 'float8', notNull: true },
    is_default: { type: 'boolean', notNull: true, default: false },
    created_at: now(),
    updated_at: now(),
  });
  pgm.createIndex('delivery_addresses', 'user_id', { name: 'delivery_addresses_user_idx' });

  // One server-side cart per customer.
  pgm.createTable('carts', {
    id,
    customer_id: { type: 'bigint', notNull: true, unique: true, references: 'users(id)', onDelete: 'CASCADE' },
    restaurant_id: { type: 'bigint', references: 'restaurants(id)', onDelete: 'SET NULL' }, // set by the first item
    delivery_address_id: { type: 'bigint', references: 'delivery_addresses(id)', onDelete: 'SET NULL' },
    created_at: now(),
    updated_at: now(),
  });

  // Cart lines. No prices are stored: totals are always recomputed on the server.
  pgm.createTable('cart_items', {
    id,
    cart_id: { type: 'bigint', notNull: true, references: 'carts(id)', onDelete: 'CASCADE' },
    menu_item_id: { type: 'bigint', notNull: true, references: 'menu_items(id)', onDelete: 'CASCADE' },
    quantity: { type: 'int', notNull: true },
    created_at: now(),
    updated_at: now(),
  });
  pgm.createIndex('cart_items', ['cart_id', 'menu_item_id'], { name: 'cart_items_cart_item_uq', unique: true });
  pgm.createIndex('cart_items', 'menu_item_id', { name: 'cart_items_item_idx' });
};

exports.down = (pgm) => {
  pgm.dropTable('cart_items');
  pgm.dropTable('carts');
  pgm.dropTable('delivery_addresses');
};