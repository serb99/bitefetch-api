/**
 * Migration 11 - partition helpers, default settings, retention function, CHECK constraints
 * (constraints.sql sections 10, 11, 12 and 13).
 *
 * - order_status_history is already partitioned (migration 6). Here: ensure_monthly_partitions() and
 *   drop_old_partitions(), and the partitions for this month and the next 3 are created.
 * - platform_settings: migration 7 seeded provisional keys. They are replaced by the keys from
 *   constraints.sql section 11, with the money values in EURO CENTS instead of bani:
 *     min_order_minor 500 (5 EUR), delivery_fee_base_minor 150 (1.50 EUR), per extra km 40 (0.40 EUR).
 *   Change them if you want other prices.
 * - run_retention(): called by the worker service once per hour, deletes old rows in batches.
 * - 62 CHECK constraints, added with pgm.addConstraint (a violation raises SQLSTATE 23514).
 *
 * Source of truth: docs/design/database/constraints.sql.
 */

exports.shorthands = undefined;

// [table, constraint name, condition]
const CHECKS = [
  ['users', 'users_deleted_consistent', `(status = 'deleted') = (deleted_at IS NOT NULL)`],
  ['users', 'users_approval_roles', `status <> 'pending_approval' OR role IN ('courier', 'restaurant_owner')`],
  ['users', 'users_counters_non_negative', `token_version >= 0 AND version >= 0`],
  ['courier_profiles', 'courier_profiles_offline_reason', `(availability = 'online') = (offline_reason IS NULL)`],
  ['courier_profiles', 'courier_profiles_missed_non_negative', `consecutive_missed_offers >= 0`],
  ['applications', 'applications_role', `role IN ('courier', 'restaurant_owner')`],
  ['applications', 'applications_attempts', `attempt_no BETWEEN 1 AND 3`],
  ['applications', 'applications_decided_consistent', `(status = 'pending') = (decided_at IS NULL)`],
  ['applications', 'applications_reject_reason', `status <> 'rejected' OR reject_reason IS NOT NULL`],
  ['applications', 'applications_restaurant_owner_only', `role = 'restaurant_owner' OR restaurant_id IS NULL`],
  ['email_tokens', 'email_tokens_expiry_after_creation', `expires_at > created_at`],
  ['brands', 'brands_private_no_osm_tag', `kind = 'chain' OR osm_brand_tag IS NULL`],
  ['restaurants', 'restaurants_coordinates', `lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180`],
  ['restaurants', 'restaurants_timeouts_non_negative', `consecutive_timeouts >= 0`],
  ['restaurants', 'restaurants_owned_have_hours', `owner_id IS NULL OR opening_hours IS NOT NULL`],
  ['menu_items', 'menu_items_price_non_negative', `price_minor >= 0`],
  ['menu_items', 'menu_items_currency_format', `currency ~ '^[A-Z]{3}$'`],
  ['delivery_addresses', 'delivery_addresses_coordinates', `lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180`],
  ['cart_items', 'cart_items_quantity', `quantity BETWEEN 1 AND 50`],
  ['orders', 'orders_total_sum', `total_minor = subtotal_minor + delivery_fee_minor`],
  ['orders', 'orders_amounts_non_negative', `subtotal_minor >= 0 AND delivery_fee_minor >= 0 AND delivery_distance_m >= 0`],
  ['orders', 'orders_currency_format', `currency ~ '^[A-Z]{3}$'`],
  ['orders', 'orders_attempts', `payment_attempts BETWEEN 0 AND 5 AND capture_attempts >= 0`],
  ['orders', 'orders_dispatch_round', `dispatch_round >= 0`],
  ['orders', 'orders_prep_minutes', `prep_minutes IS NULL OR (prep_minutes BETWEEN 10 AND 60 AND prep_minutes % 5 = 0)`],
  ['orders', 'orders_no_courier_before_accept', `status NOT IN ('pending_payment', 'placed') OR courier_id IS NULL`],
  ['orders', 'orders_placed_fields', `status NOT IN ('placed', 'accepted', 'ready_for_pickup', 'picked_up', 'delivered', 'rejected') OR (placed_at IS NOT NULL AND accept_deadline IS NOT NULL)`],
  ['orders', 'orders_accepted_fields', `status NOT IN ('accepted', 'ready_for_pickup', 'picked_up', 'delivered') OR (accepted_at IS NOT NULL AND prep_minutes IS NOT NULL AND estimated_ready_at IS NOT NULL AND dispatch_after IS NOT NULL)`],
  ['orders', 'orders_ready_fields', `status <> 'ready_for_pickup' OR ready_at IS NOT NULL`],
  ['orders', 'orders_pickup_fields', `status NOT IN ('picked_up', 'delivered') OR (courier_id IS NOT NULL AND picked_up_at IS NOT NULL)`],
  ['orders', 'orders_delivered_fields', `status <> 'delivered' OR delivered_at IS NOT NULL`],
  ['orders', 'orders_ended_at', `(status IN ('delivered', 'cancelled', 'rejected', 'expired')) = (ended_at IS NOT NULL)`],
  ['orders', 'orders_cancelled_by', `(status IN ('cancelled', 'rejected', 'expired')) = (cancelled_by IS NOT NULL)`],
  ['orders', 'orders_assignment_consistent', `status NOT IN ('accepted', 'ready_for_pickup') OR ((dispatch_state = 'assigned') = (courier_id IS NOT NULL))`],
  ['orders', 'orders_dispatch_started_fields', `dispatch_state = 'not_started' OR (dispatch_started_at IS NOT NULL AND dispatch_deadline IS NOT NULL AND dispatch_round >= 1)`],
  ['orders', 'orders_authorized_while_active', `status NOT IN ('placed', 'accepted', 'ready_for_pickup', 'picked_up') OR payment_status = 'authorized'`],
  ['orders', 'orders_capture_only_delivered', `payment_status NOT IN ('captured', 'capture_failed') OR status = 'delivered'`],
  ['order_items', 'order_items_price_non_negative', `unit_price_minor >= 0`],
  ['order_items', 'order_items_quantity', `quantity BETWEEN 1 AND 50`],
  ['order_items', 'order_items_line_total', `line_total_minor = unit_price_minor * quantity`],
  ['order_offers', 'order_offers_round', `round >= 1`],
  ['order_offers', 'order_offers_expiry_after_offer', `expires_at > offered_at`],
  ['order_offers', 'order_offers_responded_consistent', `(status = 'pending') = (responded_at IS NULL)`],
  ['order_offers', 'order_offers_decline_reason', `decline_reason IS NULL OR status = 'declined'`],
  ['order_cancel_requests', 'order_cancel_requests_decided_consistent', `(status = 'pending') = (decided_at IS NULL)`],
  ['order_incidents', 'order_incidents_category', `(type = 'courier_problem') = (category IS NOT NULL)`],
  ['order_incidents', 'order_incidents_scope', `(type = 'restaurant_unresponsive') = (order_id IS NULL)`],
  ['order_incidents', 'order_incidents_restaurant_set', `restaurant_id IS NOT NULL`],
  ['order_incidents', 'order_incidents_resolved_consistent', `resolved_by IS NULL OR resolved_at IS NOT NULL`],
  ['route_cache', 'route_cache_non_negative', `distance_m >= 0 AND duration_s >= 0`],
  ['courier_positions', 'courier_positions_coordinates', `lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180`],
  ['outbox', 'outbox_attempts_non_negative', `attempts >= 0`],
  ['conversations', 'conversations_order_fields', `type <> 'order' OR (order_id IS NOT NULL AND restaurant_id IS NOT NULL)`],
  ['conversations', 'conversations_support_fields', `type <> 'support' OR restaurant_id IS NULL`],
  ['conversations', 'conversations_closed_consistent', `(status = 'closed') = (closed_at IS NOT NULL)`],
  ['conversations', 'conversations_resolved_consistent', `status <> 'resolved' OR resolved_at IS NOT NULL`],
  ['conversations', 'conversations_last_seq', `last_seq >= 0`],
  ['messages', 'messages_seq', `seq >= 1`],
  ['messages', 'messages_body_length', `char_length(body) BETWEEN 1 AND 2000`],
  ['messages', 'messages_system_sender', `(kind = 'system') = (sender_id IS NULL)`],
  ['messages', 'messages_client_id_for_text', `kind = 'system' OR client_msg_id IS NOT NULL`],
  ['conversation_reads', 'conversation_reads_seq', `last_read_seq >= 0`],
];

const OLD_SETTING_KEYS = [
  'payment_window_seconds',
  'accept_window_seconds',
  'offer_timeout_seconds',
  'dispatch_deadline_seconds',
  'dispatch_radii_km',
  'proximity_m',
  'min_order_minor',
  'delivery_base_fee_minor',
  'delivery_base_distance_m',
  'delivery_extra_fee_per_km_minor',
];

exports.up = (pgm) => {
  // partitioning helpers + the partitions for the current and the next months
  pgm.sql(`
-- creates the partitions for the current month and the next p_months_ahead months
CREATE OR REPLACE FUNCTION ensure_monthly_partitions(p_parent text, p_months_ahead int DEFAULT 3)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  m     date;
  pname text;
BEGIN
  FOR i IN 0..p_months_ahead LOOP
    m := (date_trunc('month', now()) + make_interval(months => i))::date;
    pname := format('%s_y%sm%s', p_parent, to_char(m, 'YYYY'), to_char(m, 'MM'));
    IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = pname) THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF %I FOR VALUES FROM (%L) TO (%L)',
                     pname, p_parent, m, (m + interval '1 month')::date);
    END IF;
  END LOOP;
END $$;

-- detaches and drops monthly partitions older than p_keep_months full months
CREATE OR REPLACE FUNCTION drop_old_partitions(p_parent text, p_keep_months int DEFAULT 12)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  part   record;
  cutoff date := (date_trunc('month', now()) - make_interval(months => p_keep_months))::date;
BEGIN
  FOR part IN
    SELECT c.relname
      FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = p_parent
       AND c.relname ~ '_y[0-9]{4}m[0-9]{2}$'
       AND to_date(substring(c.relname from '_y([0-9]{4})m') || substring(c.relname from 'm([0-9]{2})$'), 'YYYYMM') < cutoff
  LOOP
    EXECUTE format('ALTER TABLE %I DETACH PARTITION %I', p_parent, part.relname);
    EXECUTE format('DROP TABLE %I', part.relname);
  END LOOP;
END $$;

SELECT ensure_monthly_partitions('order_status_history', 3)
 WHERE EXISTS (SELECT 1 FROM pg_partitioned_table pt JOIN pg_class c ON c.oid = pt.partrelid
                WHERE c.relname = 'order_status_history');
`);

  // settings: replace the provisional keys from migration 7 with the final ones
  pgm.sql(`DELETE FROM platform_settings WHERE key IN (${OLD_SETTING_KEYS.map((k) => `'${k}'`).join(', ')});`);
  pgm.sql(`
INSERT INTO platform_settings (key, value, description) VALUES
  ('min_order_minor',                 '500',  'R2: minimum order subtotal, euro cents (5 EUR)'),
  ('delivery_fee_base_minor',         '150',  'R2: delivery fee up to the base distance, euro cents (1.50 EUR)'),
  ('delivery_fee_base_km',            '3',    'R2: route km included in the base fee'),
  ('delivery_fee_per_extra_km_minor', '40',   'R2: per started extra km, euro cents (0.40 EUR)'),
  ('max_delivery_distance_m',         '7000', 'assumed: T1 "address in range" limit (route distance)'),
  ('offer_timeout_s',                 '30',   'R2: server offer deadline (app shows 25 s)'),
  ('accept_window_s',                 '300',  'R2: restaurant accept window'),
  ('payment_window_s',                '900',  'R2: checkout payment window'),
  ('max_payment_attempts',            '5',    'flow 6 Q1'),
  ('reconcile_after_s',               '120',  'flow 6 Q2'),
  ('capture_auto_retries',            '3',    'flow 6 Q3'),
  ('prep_minutes_default',            '20',   'R3'),
  ('dispatch_lead_s',                 '600',  'R3: dispatch_after = estimated_ready_at - 10 min'),
  ('dispatch_deadline_s',             '900',  'S6: no_courier after 15 min'),
  ('second_round_after_s',            '300',  'S9: automatic second round after 5 min'),
  ('courier_fresh_position_s',        '30',   'flow 3 Q3: offers only to fresh positions'),
  ('courier_no_position_offline_s',   '120',  'R10: offline after 2 min without a position'),
  ('kitchen_late_after_s',            '600',  'R4'),
  ('delivery_overdue_after_s',        '1800', 'R7'),
  ('customer_unreachable_wait_s',     '600',  'R6'),
  ('location_check_radius_m',         '150',  'T12/T13 courier location check')
ON CONFLICT (key) DO NOTHING;
`);

  // retention
  pgm.sql(`
CREATE OR REPLACE FUNCTION run_retention(p_batch int DEFAULT 5000)
RETURNS TABLE (target text, deleted bigint) LANGUAGE plpgsql AS $$
DECLARE
  n bigint;
BEGIN
  DELETE FROM outbox WHERE id IN (
    SELECT id FROM outbox WHERE processed_at < now() - interval '7 days' LIMIT p_batch);
  GET DIAGNOSTICS n = ROW_COUNT; target := 'outbox'; deleted := n; RETURN NEXT;

  DELETE FROM stripe_events WHERE event_id IN (
    SELECT event_id FROM stripe_events WHERE received_at < now() - interval '30 days' LIMIT p_batch);
  GET DIAGNOSTICS n = ROW_COUNT; target := 'stripe_events'; deleted := n; RETURN NEXT;

  DELETE FROM refresh_tokens WHERE id IN (
    SELECT id FROM refresh_tokens WHERE expires_at < now() - interval '30 days' LIMIT p_batch);
  GET DIAGNOSTICS n = ROW_COUNT; target := 'refresh_tokens'; deleted := n; RETURN NEXT;

  DELETE FROM email_tokens WHERE id IN (
    SELECT id FROM email_tokens WHERE expires_at < now() - interval '30 days' LIMIT p_batch);
  GET DIAGNOSTICS n = ROW_COUNT; target := 'email_tokens'; deleted := n; RETURN NEXT;

  DELETE FROM order_offers WHERE id IN (
    SELECT id FROM order_offers WHERE offered_at < now() - interval '12 months' LIMIT p_batch);
  GET DIAGNOSTICS n = ROW_COUNT; target := 'order_offers'; deleted := n; RETURN NEXT;

  DELETE FROM route_cache WHERE cache_key IN (
    SELECT cache_key FROM route_cache WHERE expires_at < now() LIMIT p_batch);
  GET DIAGNOSTICS n = ROW_COUNT; target := 'route_cache'; deleted := n; RETURN NEXT;

  DELETE FROM osm_search_cache WHERE id IN (
    SELECT id FROM osm_search_cache WHERE expires_at < now() LIMIT p_batch);
  GET DIAGNOSTICS n = ROW_COUNT; target := 'osm_search_cache'; deleted := n; RETURN NEXT;

  DELETE FROM cart_items WHERE cart_id IN (
    SELECT id FROM carts WHERE updated_at < now() - interval '30 days' LIMIT p_batch);
  GET DIAGNOSTICS n = ROW_COUNT; target := 'cart_items (stale carts)'; deleted := n; RETURN NEXT;

  DELETE FROM admin_audit_log WHERE id IN (
    SELECT id FROM admin_audit_log WHERE at < now() - interval '24 months' LIMIT p_batch);
  GET DIAGNOSTICS n = ROW_COUNT; target := 'admin_audit_log'; deleted := n; RETURN NEXT;

  -- A4: accounts never activated within 7 days (cascades to tokens, applications, history)
  DELETE FROM users WHERE id IN (
    SELECT id FROM users
     WHERE status = 'pending_activation' AND created_at < now() - interval '7 days'
     LIMIT p_batch FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS n = ROW_COUNT; target := 'users (A4 purge)'; deleted := n; RETURN NEXT;

  -- order_status_history: drop monthly partitions older than 12 months, prepare upcoming ones
  IF EXISTS (SELECT 1 FROM pg_partitioned_table pt JOIN pg_class c ON c.oid = pt.partrelid
              WHERE c.relname = 'order_status_history') THEN
    PERFORM drop_old_partitions('order_status_history', 12);
    PERFORM ensure_monthly_partitions('order_status_history', 3);
  END IF;
END $$;
`);

  // CHECK constraints
  for (const [table, name, expr] of CHECKS) {
    pgm.addConstraint(table, name, { check: expr });
  }
};

exports.down = (pgm) => {
  for (const [table, name] of [...CHECKS].reverse()) {
    pgm.dropConstraint(table, name);
  }
  // the monthly partitions created by ensure_monthly_partitions (the default partition stays)
  pgm.sql(`
DO $$
DECLARE part text;
BEGIN
  FOR part IN
    SELECT c.relname FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_class p ON p.oid = i.inhparent
     WHERE p.relname = 'order_status_history' AND c.relname ~ '_y[0-9]{4}m[0-9]{2}$'
  LOOP
    EXECUTE format('DROP TABLE %I', part);
  END LOOP;
END $$;`);
  pgm.sql('DROP FUNCTION IF EXISTS run_retention(int);');
  pgm.sql(`DELETE FROM platform_settings WHERE key IN ('min_order_minor', 'delivery_fee_base_minor', 'delivery_fee_base_km', 'delivery_fee_per_extra_km_minor', 'max_delivery_distance_m', 'offer_timeout_s', 'accept_window_s', 'payment_window_s', 'max_payment_attempts', 'reconcile_after_s', 'capture_auto_retries', 'prep_minutes_default', 'dispatch_lead_s', 'dispatch_deadline_s', 'second_round_after_s', 'courier_fresh_position_s', 'courier_no_position_offline_s', 'kitchen_late_after_s', 'delivery_overdue_after_s', 'customer_unreachable_wait_s', 'location_check_radius_m');`);
  pgm.sql('DROP FUNCTION IF EXISTS drop_old_partitions(text, int);');
  pgm.sql('DROP FUNCTION IF EXISTS ensure_monthly_partitions(text, int);');
};