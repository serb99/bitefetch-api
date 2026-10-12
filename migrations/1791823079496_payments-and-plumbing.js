/**
 * Migration 7: payments and plumbing.
 * Tables: stripe_events, outbox, platform_settings, admin_audit_log (+ default settings).
 * Source of truth: docs/design/database/schema.dbml (group "payments_and_plumbing").
 *
 * Money in platform_settings is in euro cents (the *_minor keys).
 */

exports.shorthands = undefined;

const id = { type: 'bigint', primaryKey: true, sequenceGenerated: { precedence: 'BY DEFAULT' } };

// key, value (JSON), description. Times are in seconds, distances in meters or km as the key says.
const DEFAULT_SETTINGS = [
  ['payment_window_seconds', '900', 'How long a customer has to pay before the order expires (15 min).'],
  ['accept_window_seconds', '300', 'How long the restaurant has to accept a placed order (5 min).'],
  ['offer_timeout_seconds', '30', 'How long a courier has to answer an offer.'],
  ['dispatch_deadline_seconds', '900', 'How long the courier search runs before the order is flagged as having no courier (15 min).'],
  ['dispatch_radii_km', '[3, 6, 10]', 'Courier search radii, tried in order.'],
  ['proximity_m', '150', 'How close a courier must be to the restaurant or the customer to confirm pickup or delivery.'],
  ['min_order_minor', '500', 'Minimum order subtotal, in euro cents (5.00 EUR).'],
  ['delivery_base_fee_minor', '150', 'Delivery fee up to the base distance, in euro cents (1.50 EUR).'],
  ['delivery_base_distance_m', '3000', 'Distance covered by the base delivery fee (3 km).'],
  ['delivery_extra_fee_per_km_minor', '40', 'Added for every started kilometer beyond the base distance, in euro cents (0.40 EUR).'],
];

exports.up = (pgm) => {
  const now = () => ({ type: 'timestamptz', notNull: true, default: pgm.func('now()') });

  // Webhook deduplication: insert the Stripe event id first; a duplicate insert means "already handled".
  pgm.createTable('stripe_events', {
    event_id: { type: 'varchar(255)', primaryKey: true },
    type: { type: 'varchar(100)', notNull: true },
    payment_intent_id: { type: 'varchar(64)' },
    received_at: now(),
  });
  pgm.createIndex('stripe_events', 'received_at', { name: 'stripe_events_received_idx' });
  pgm.createIndex('stripe_events', 'payment_intent_id', { name: 'stripe_events_pi_idx' });

  // Transactional outbox: side effects (Stripe calls, socket events, emails) written in the same
  // transaction as the state change, then run by a worker.
  pgm.createTable('outbox', {
    id,
    topic: { type: 'varchar(64)', notNull: true }, // payment.void | payment.capture | socket.emit | email.* ...
    order_id: { type: 'bigint' }, // tracing only, no foreign key on purpose
    payload: { type: 'jsonb', notNull: true },
    idempotency_key: { type: 'varchar(200)', notNull: true, unique: true }, // e.g. 'order:42:void'
    attempts: { type: 'int', notNull: true, default: 0 },
    next_attempt_at: now(),
    last_error: { type: 'text' },
    processed_at: { type: 'timestamptz' },
    created_at: now(),
  });

  // Admin-editable settings (key -> JSON value).
  pgm.createTable('platform_settings', {
    key: { type: 'varchar(64)', primaryKey: true },
    value: { type: 'jsonb', notNull: true },
    description: { type: 'varchar(300)' },
    updated_by: { type: 'bigint', references: 'users(id)', onDelete: 'SET NULL' },
    updated_at: now(),
  });

  // Who did what as admin, including read-only access to order chats.
  pgm.createTable('admin_audit_log', {
    id,
    admin_id: { type: 'bigint', notNull: true, references: 'users(id)', onDelete: 'RESTRICT' },
    action: { type: 'varchar(64)', notNull: true }, // 'order_chat.read', 'order.cancel', 'user.suspend', ...
    target_type: { type: 'varchar(32)', notNull: true }, // 'conversation', 'order', 'user', 'restaurant'
    target_id: { type: 'bigint', notNull: true },
    details: { type: 'jsonb' }, // reason, version seen, request id
    at: now(),
  });
  pgm.createIndex('admin_audit_log', ['admin_id', 'at'], { name: 'admin_audit_log_admin_idx' });
  pgm.createIndex('admin_audit_log', ['target_type', 'target_id', 'at'], { name: 'admin_audit_log_target_idx' });
  pgm.createIndex('admin_audit_log', 'at', { name: 'admin_audit_log_at_idx' });

  // Default settings. Values are copied into orders / offers when used, so editing a setting later
  // never moves the deadlines of orders that already exist.
  const rows = DEFAULT_SETTINGS.map(
    ([key, value, description]) => `('${key}', '${value}'::jsonb, '${description.replace(/'/g, "''")}')`,
  ).join(',\n    ');
  pgm.sql(`INSERT INTO platform_settings (key, value, description) VALUES\n    ${rows};`);
};

exports.down = (pgm) => {
  pgm.dropTable('admin_audit_log');
  pgm.dropTable('platform_settings');
  pgm.dropTable('outbox');
  pgm.dropTable('stripe_events');
};