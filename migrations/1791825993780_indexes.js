/**
 * Migration 9 - special indexes (constraints.sql sections 1-8).
 *
 * Partial indexes (only the rows a query or a sweeper can pick), partial UNIQUE indexes
 * (business rules such as "one pending application per user"), bounding-box indexes and two storage
 * settings (fillfactor for courier_positions, autovacuum for outbox).
 * Four indexes from constraints.sql already exist from earlier migrations (same names, IF NOT EXISTS
 * makes them a no-op): users_email_lower_uq, orders_order_code_uq, orders_customer_idempotency_uq,
 * order_offers_once_per_round_uq. The down migration does not touch those.
 *
 * Source of truth: database/constraints.sql.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
-- unique email, case-insensitive (also declared in schema.dbml)
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_uq ON users (lower(email));

-- A4: purge accounts never activated within 7 days
CREATE INDEX IF NOT EXISTS users_pending_activation_idx
  ON users (created_at) WHERE status = 'pending_activation';

-- one pending application per user (A1, A7)
CREATE UNIQUE INDEX IF NOT EXISTS applications_one_pending_uq
  ON applications (user_id) WHERE status = 'pending';

-- resend (N7) invalidates the user's live tokens of the same type
CREATE INDEX IF NOT EXISTS email_tokens_live_idx
  ON email_tokens (user_id, type) WHERE used_at IS NULL AND revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS email_tokens_expires_idx ON email_tokens (expires_at);

-- revoke all live refresh tokens of a user (password reset, A8, A10, A11)
CREATE INDEX IF NOT EXISTS refresh_tokens_live_user_idx
  ON refresh_tokens (user_id) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS refresh_tokens_expires_idx ON refresh_tokens (expires_at);

-- "restaurants near an address": bounding-box filter on plain lat/lng
-- (see docs/schema-notes.md §6 for the PostGIS upgrade path)
CREATE INDEX IF NOT EXISTS restaurants_lat_lng_idx ON restaurants (lat, lng);

-- one default address per user ("Set default address")
CREATE UNIQUE INDEX IF NOT EXISTS delivery_addresses_one_default_uq
  ON delivery_addresses (user_id) WHERE is_default;

-- stale carts (retention, §12)
CREATE INDEX IF NOT EXISTS carts_updated_idx ON carts (updated_at);

-- also declared in schema.dbml
CREATE UNIQUE INDEX IF NOT EXISTS orders_order_code_uq ON orders (order_code);
CREATE UNIQUE INDEX IF NOT EXISTS orders_customer_idempotency_uq ON orders (customer_id, idempotency_key);

-- one active delivery per courier
CREATE UNIQUE INDEX IF NOT EXISTS orders_one_active_per_courier_uq
  ON orders (courier_id)
  WHERE courier_id IS NOT NULL AND status IN ('accepted', 'ready_for_pickup', 'picked_up');

-- active orders per restaurant (owner dashboard) and per customer (tracking)
CREATE INDEX IF NOT EXISTS orders_active_restaurant_idx
  ON orders (restaurant_id, placed_at DESC)
  WHERE status IN ('placed', 'accepted', 'ready_for_pickup', 'picked_up');
CREATE INDEX IF NOT EXISTS orders_active_customer_idx
  ON orders (customer_id)
  WHERE status IN ('pending_payment', 'placed', 'accepted', 'ready_for_pickup', 'picked_up');
-- (active per courier is served by orders_one_active_per_courier_uq)

-- sweeper indexes: each one only holds the rows its sweeper can pick
CREATE INDEX IF NOT EXISTS orders_payment_expires_idx          -- T4
  ON orders (payment_expires_at) WHERE status = 'pending_payment';
CREATE INDEX IF NOT EXISTS orders_reconcile_idx                -- T3/T4 reconciliation after 2 min
  ON orders (created_at) WHERE status = 'pending_payment' AND stripe_payment_intent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS orders_accept_deadline_idx          -- T8
  ON orders (accept_deadline) WHERE status = 'placed';
CREATE INDEX IF NOT EXISTS orders_dispatch_after_idx           -- S1
  ON orders (dispatch_after)
  WHERE status IN ('accepted', 'ready_for_pickup') AND dispatch_state = 'not_started';
CREATE INDEX IF NOT EXISTS orders_next_search_idx              -- S2 backoff, S9
  ON orders (next_search_at)
  WHERE status IN ('accepted', 'ready_for_pickup') AND dispatch_state IN ('searching', 'no_courier');
CREATE INDEX IF NOT EXISTS orders_dispatch_deadline_idx        -- S6
  ON orders (dispatch_deadline)
  WHERE status IN ('accepted', 'ready_for_pickup') AND dispatch_state = 'searching';
CREATE INDEX IF NOT EXISTS orders_kitchen_late_idx             -- R4
  ON orders (estimated_ready_at) WHERE status = 'accepted';
CREATE INDEX IF NOT EXISTS orders_delivery_overdue_idx         -- R7
  ON orders (estimated_delivery_at) WHERE status = 'picked_up';
CREATE INDEX IF NOT EXISTS orders_capture_failed_idx           -- flow 6 admin list
  ON orders (delivered_at) WHERE payment_status = 'capture_failed';

-- also declared in schema.dbml: nobody asked twice per round
CREATE UNIQUE INDEX IF NOT EXISTS order_offers_once_per_round_uq
  ON order_offers (order_id, round, courier_id);

-- one courier at a time per order; one offer at a time per courier
CREATE UNIQUE INDEX IF NOT EXISTS order_offers_one_pending_per_order_uq
  ON order_offers (order_id) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS order_offers_one_pending_per_courier_uq
  ON order_offers (courier_id) WHERE status = 'pending';

-- S4 expiry sweep
CREATE INDEX IF NOT EXISTS order_offers_pending_expiry_idx
  ON order_offers (expires_at) WHERE status = 'pending';

-- online couriers (candidate list, R10 no-position sweeper)
CREATE INDEX IF NOT EXISTS courier_profiles_online_idx
  ON courier_profiles (user_id) WHERE availability = 'online';

-- nearest courier: bounding box on lat/lng, freshness on received_at
CREATE INDEX IF NOT EXISTS courier_positions_lat_lng_idx ON courier_positions (lat, lng);
CREATE INDEX IF NOT EXISTS courier_positions_received_idx ON courier_positions (received_at);

-- positions are rewritten every ~3 s: leave room in each page for HOT updates
ALTER TABLE courier_positions SET (fillfactor = 50);

-- T14: one pending cancellation request per order
CREATE UNIQUE INDEX IF NOT EXISTS order_cancel_requests_one_pending_uq
  ON order_cancel_requests (order_id) WHERE status = 'pending';

-- one open incident per order and type (sweepers on several instances never duplicate)
CREATE UNIQUE INDEX IF NOT EXISTS order_incidents_one_open_uq
  ON order_incidents (order_id, type) WHERE resolved_at IS NULL AND order_id IS NOT NULL;

-- one open restaurant_unresponsive incident per restaurant
CREATE UNIQUE INDEX IF NOT EXISTS order_incidents_restaurant_open_uq
  ON order_incidents (restaurant_id) WHERE resolved_at IS NULL AND type = 'restaurant_unresponsive';

-- admin incident list
CREATE INDEX IF NOT EXISTS order_incidents_open_idx
  ON order_incidents (opened_at) WHERE resolved_at IS NULL;

-- outbox worker: claim unprocessed rows that are due
CREATE INDEX IF NOT EXISTS outbox_unprocessed_idx
  ON outbox (next_attempt_at) WHERE processed_at IS NULL;
-- retention: processed rows older than 7 days
CREATE INDEX IF NOT EXISTS outbox_processed_idx
  ON outbox (processed_at) WHERE processed_at IS NOT NULL;

-- the outbox churns constantly: vacuum it more eagerly than the default
ALTER TABLE outbox SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);

-- one order chat per order
CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_order_chat_uq
  ON conversations (order_id) WHERE type = 'order';

-- one live support chat per customer (open or resolved: a customer reply reopens it, C4)
CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_support_chat_uq
  ON conversations (customer_id) WHERE type = 'support' AND status <> 'closed';

-- C5 close sweep and unread-reply emails
CREATE INDEX IF NOT EXISTS conversations_not_closed_idx
  ON conversations (type, status) WHERE status <> 'closed';
`);
};

exports.down = (pgm) => {
  pgm.sql('ALTER TABLE courier_positions RESET (fillfactor);');
  pgm.sql('ALTER TABLE outbox RESET (autovacuum_vacuum_scale_factor, autovacuum_analyze_scale_factor);');
  pgm.sql(`DROP INDEX IF EXISTS
  users_pending_activation_idx,
  applications_one_pending_uq,
  email_tokens_live_idx,
  email_tokens_expires_idx,
  refresh_tokens_live_user_idx,
  refresh_tokens_expires_idx,
  restaurants_lat_lng_idx,
  delivery_addresses_one_default_uq,
  carts_updated_idx,
  orders_one_active_per_courier_uq,
  orders_active_restaurant_idx,
  orders_active_customer_idx,
  orders_payment_expires_idx,
  orders_reconcile_idx,
  orders_accept_deadline_idx,
  orders_dispatch_after_idx,
  orders_next_search_idx,
  orders_dispatch_deadline_idx,
  orders_kitchen_late_idx,
  orders_delivery_overdue_idx,
  orders_capture_failed_idx,
  order_offers_one_pending_per_order_uq,
  order_offers_one_pending_per_courier_uq,
  order_offers_pending_expiry_idx,
  courier_profiles_online_idx,
  courier_positions_lat_lng_idx,
  courier_positions_received_idx,
  order_cancel_requests_one_pending_uq,
  order_incidents_one_open_uq,
  order_incidents_restaurant_open_uq,
  order_incidents_open_idx,
  outbox_unprocessed_idx,
  outbox_processed_idx,
  conversations_one_order_chat_uq,
  conversations_one_support_chat_uq,
  conversations_not_closed_idx;`);
};