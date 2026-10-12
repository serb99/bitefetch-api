/**
 * Migration 6: orders and dispatch.
 * Tables: orders, order_items, order_status_history (partitioned), order_offers,
 *         order_cancel_requests, order_incidents, route_cache, courier_positions.
 * Source of truth: docs/design/database/schema.dbml (group "orders_and_dispatch").
 *
 * order_status_history is created PARTITIONED BY RANGE (at) from the start: a normal table cannot
 * be turned into a partitioned one later without copying all its rows. It also gets a DEFAULT
 * partition so an insert never fails; the monthly partitions and their maintenance come later.
 * Identity columns on partitioned tables need PostgreSQL 17 or newer.
 */

exports.shorthands = undefined;

const id = { type: 'bigint', primaryKey: true, sequenceGenerated: { precedence: 'BY DEFAULT' } };

exports.up = (pgm) => {
  const now = () => ({ type: 'timestamptz', notNull: true, default: pgm.func('now()') });

  // ---------------------------------------------------------------- orders
  // One row per order. status, dispatch_state and payment_status are three parallel state machines.
  // Never deleted, never cascaded: every foreign key into orders is RESTRICT.
  pgm.createTable('orders', {
    id,
    order_code: { type: 'varchar(8)', notNull: true }, // display code 'BF-XXXXX'; unique index below
    customer_id: { type: 'bigint', notNull: true, references: 'users(id)', onDelete: 'RESTRICT' },
    restaurant_id: { type: 'bigint', notNull: true, references: 'restaurants(id)', onDelete: 'RESTRICT' },
    courier_id: { type: 'bigint', references: 'users(id)', onDelete: 'RESTRICT' }, // set on assignment
    delivery_address_id: { type: 'bigint', references: 'delivery_addresses(id)', onDelete: 'SET NULL' }, // reference only; the snapshot is authoritative
    idempotency_key: { type: 'varchar(100)', notNull: true }, // Idempotency-Key header; unique per customer
    status: { type: 'order_status', notNull: true, default: 'pending_payment' },
    version: { type: 'int', notNull: true, default: 0 }, // optimistic lock and socket event ordering

    // money (integer)
    subtotal_minor: { type: 'int', notNull: true },
    delivery_fee_minor: { type: 'int', notNull: true },
    total_minor: { type: 'int', notNull: true },
    currency: { type: 'char(3)', notNull: true, default: 'EURO' },
    delivery_distance_m: { type: 'int', notNull: true }, // route distance at checkout; drives the delivery fee
    delivery_address_snapshot: { type: 'jsonb', notNull: true }, // label, street, details, city, lat, lng at checkout
    delivery_lat: { type: 'float8', notNull: true },
    delivery_lng: { type: 'float8', notNull: true },

    // payment
    payment_status: { type: 'payment_status', notNull: true, default: 'pending' },
    stripe_payment_intent_id: { type: 'varchar(64)', unique: true }, // one PaymentIntent per order
    payment_expires_at: { type: 'timestamptz', notNull: true },
    payment_attempts: { type: 'int', notNull: true, default: 0 },
    last_payment_error: { type: 'varchar(200)' },
    capture_attempts: { type: 'int', notNull: true, default: 0 },

    // restaurant side
    placed_at: { type: 'timestamptz' },
    accept_deadline: { type: 'timestamptz' },
    accepted_at: { type: 'timestamptz' },
    prep_minutes: { type: 'int' },
    estimated_ready_at: { type: 'timestamptz' },
    ready_at: { type: 'timestamptz' },

    // dispatch (courier search)
    dispatch_state: { type: 'dispatch_state', notNull: true, default: 'not_started' },
    dispatch_round: { type: 'int', notNull: true, default: 0 },
    dispatch_after: { type: 'timestamptz' },
    dispatch_started_at: { type: 'timestamptz' },
    dispatch_deadline: { type: 'timestamptz' },
    next_search_at: { type: 'timestamptz' },

    // delivery
    picked_up_at: { type: 'timestamptz' },
    estimated_delivery_at: { type: 'timestamptz' },
    delivered_at: { type: 'timestamptz' },

    // end of life
    ended_at: { type: 'timestamptz' },
    cancelled_by: { type: 'cancel_actor' },
    cancel_reason: { type: 'varchar(50)' },
    cancel_note: { type: 'varchar(500)' },
    created_at: now(),
    updated_at: now(),
  });
  pgm.createIndex('orders', 'order_code', { name: 'orders_order_code_uq', unique: true });
  pgm.createIndex('orders', ['customer_id', 'idempotency_key'], { name: 'orders_customer_idempotency_uq', unique: true });
  pgm.createIndex('orders', ['customer_id', 'created_at'], { name: 'orders_customer_history_idx' });
  pgm.createIndex('orders', ['restaurant_id', 'created_at'], { name: 'orders_restaurant_history_idx' });
  pgm.createIndex('orders', ['status', 'created_at'], { name: 'orders_status_created_idx' });

  // ----------------------------------------------------------- order_items
  // Immutable lines with name and price snapshots.
  pgm.createTable('order_items', {
    id,
    order_id: { type: 'bigint', notNull: true, references: 'orders(id)', onDelete: 'RESTRICT' },
    menu_item_id: { type: 'bigint', references: 'menu_items(id)', onDelete: 'SET NULL' }, // used to rebuild the cart
    name: { type: 'varchar(200)', notNull: true }, // snapshot
    unit_price_minor: { type: 'int', notNull: true }, // snapshot, bani
    quantity: { type: 'int', notNull: true },
    line_total_minor: { type: 'int', notNull: true },
    created_at: now(),
  });
  pgm.createIndex('order_items', 'order_id', { name: 'order_items_order_idx' });

  // ---------------------------------------------------- order_status_history
  // Audit of every orders.status change (written by a trigger, migration 9). Partitioned by month on "at".
  // The primary key must include the partition column.
  pgm.createTable(
    'order_status_history',
    {
      id: { type: 'bigint', notNull: true, sequenceGenerated: { precedence: 'BY DEFAULT' } },
      order_id: { type: 'bigint', notNull: true, references: 'orders(id)', onDelete: 'RESTRICT' },
      from_status: { type: 'order_status' }, // null for the INSERT row
      to_status: { type: 'order_status', notNull: true },
      version: { type: 'int', notNull: true },
      actor: { type: 'varchar(64)', notNull: true },
      reason: { type: 'varchar(500)' },
      at: now(),
    },
    {
      constraints: { primaryKey: ['id', 'at'] },
      partition: { strategy: 'RANGE', columns: 'at' },
    },
  );
  pgm.createIndex('order_status_history', ['order_id', 'at'], { name: 'order_status_history_order_idx' });
  // Safety net: rows outside every monthly partition land here instead of failing the insert.
  pgm.sql('CREATE TABLE order_status_history_default PARTITION OF order_status_history DEFAULT;');

  // ---------------------------------------------------------- order_offers
  // Who was offered each order and the outcome; nobody is asked twice per round.
  pgm.createTable('order_offers', {
    id,
    order_id: { type: 'bigint', notNull: true, references: 'orders(id)', onDelete: 'RESTRICT' },
    courier_id: { type: 'bigint', notNull: true, references: 'users(id)', onDelete: 'RESTRICT' },
    round: { type: 'int', notNull: true, default: 1 },
    status: { type: 'offer_status', notNull: true, default: 'pending' },
    offered_at: now(),
    expires_at: { type: 'timestamptz', notNull: true },
    responded_at: { type: 'timestamptz' },
    distance_m: { type: 'int' }, // courier to restaurant at offer time
    decline_reason: { type: 'offer_decline_reason' },
  });
  pgm.createIndex('order_offers', ['order_id', 'round', 'courier_id'], { name: 'order_offers_once_per_round_uq', unique: true });
  pgm.createIndex('order_offers', ['courier_id', 'offered_at'], { name: 'order_offers_courier_idx' });
  pgm.createIndex('order_offers', 'offered_at', { name: 'order_offers_offered_at_idx' });

  // ------------------------------------------------- order_cancel_requests
  // Owner's cancellation request after READY_FOR_PICKUP, decided by an admin.
  pgm.createTable('order_cancel_requests', {
    id,
    order_id: { type: 'bigint', notNull: true, references: 'orders(id)', onDelete: 'RESTRICT' },
    requested_by: { type: 'bigint', notNull: true, references: 'users(id)', onDelete: 'RESTRICT' },
    reason_code: { type: 'varchar(50)', notNull: true },
    note: { type: 'varchar(500)' },
    status: { type: 'cancel_request_status', notNull: true, default: 'pending' },
    decided_by: { type: 'bigint', references: 'users(id)', onDelete: 'SET NULL' }, // null when superseded by pickup
    decided_at: { type: 'timestamptz' },
    version: { type: 'int', notNull: true, default: 0 },
    created_at: now(),
    updated_at: now(),
  });
  pgm.createIndex('order_cancel_requests', ['status', 'created_at'], { name: 'order_cancel_requests_queue_idx' });

  // -------------------------------------------------------- order_incidents
  // Problems that need attention; an incident never changes the order status.
  pgm.createTable('order_incidents', {
    id,
    order_id: { type: 'bigint', references: 'orders(id)', onDelete: 'RESTRICT' }, // null only for restaurant_unresponsive
    restaurant_id: { type: 'bigint', references: 'restaurants(id)', onDelete: 'RESTRICT' }, // always set (CHECK in migration 9)
    type: { type: 'incident_type', notNull: true },
    category: { type: 'courier_problem_category' }, // courier_problem only
    opened_by: { type: 'incident_opener', notNull: true },
    opened_by_user_id: { type: 'bigint', references: 'users(id)', onDelete: 'SET NULL' },
    details: { type: 'text' },
    opened_at: now(),
    resolved_at: { type: 'timestamptz' },
    resolved_by: { type: 'bigint', references: 'users(id)', onDelete: 'SET NULL' }, // null when resolved automatically
    resolution_note: { type: 'varchar(500)' },
  });
  pgm.createIndex('order_incidents', ['restaurant_id', 'opened_at'], { name: 'order_incidents_restaurant_idx' });

  // ------------------------------------------------------------ route_cache
  // Cached OSRM routes, keyed by rounded coordinates.
  pgm.createTable('route_cache', {
    cache_key: { type: 'varchar(100)', primaryKey: true },
    distance_m: { type: 'int', notNull: true },
    duration_s: { type: 'int', notNull: true },
    polyline: { type: 'text', notNull: true }, // encoded route
    fetched_at: now(),
    expires_at: { type: 'timestamptz', notNull: true },
  });
  pgm.createIndex('route_cache', 'expires_at', { name: 'route_cache_expiry_idx' });

  // ------------------------------------------------------- courier_positions
  // Latest position per courier, upserted every ~3 seconds.
  pgm.createTable('courier_positions', {
    courier_id: { type: 'bigint', primaryKey: true, references: 'courier_profiles(user_id)', onDelete: 'CASCADE' },
    lat: { type: 'float8', notNull: true },
    lng: { type: 'float8', notNull: true },
    accuracy_m: { type: 'int' },
    heading_deg: { type: 'int' },
    speed_mps: { type: 'float8' },
    recorded_at: { type: 'timestamptz', notNull: true }, // device clock
    received_at: now(), // server clock; freshness checks use this
  });
};

exports.down = (pgm) => {
  pgm.dropTable('courier_positions');
  pgm.dropTable('route_cache');
  pgm.dropTable('order_incidents');
  pgm.dropTable('order_cancel_requests');
  pgm.dropTable('order_offers');
  pgm.dropTable('order_status_history'); // also drops its partitions
  pgm.dropTable('order_items');
  pgm.dropTable('orders');
};