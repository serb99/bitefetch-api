-- =============================================================================
-- BiteFetch – special constraints, indexes, triggers, partitioning, seeds
-- =============================================================================
-- §0  How to run
--   * Requires PostgreSQL 14+ (CREATE OR REPLACE TRIGGER).
--   * Run AFTER the tables from docs/design/database/schema.dbml exist
--     (dbml2sql --postgres output, or the node-pg-migrate migrations).
--   * Idempotent: every statement can be re-run.
--   * On a live database with data, create the indexes with CREATE INDEX CONCURRENTLY
--     in their own migration (outside a transaction) instead.
--   * Indexes that DBML can also express use the same names as schema.dbml
--     (IF NOT EXISTS makes them a no-op when DBML already created them).
--   * Sections: §1 identity · §2 catalog · §3 customer side · §4 orders · §5 dispatch
--     and positions · §6 cancel requests and incidents · §7 payments and plumbing
--     · §8 chat · §9 triggers · §10 partitioning · §11 seeds · §12 retention
--     · §13 CHECK constraints (DBML has no checks block)
-- =============================================================================


-- =============================================================================
-- §1 Identity
-- =============================================================================

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


-- =============================================================================
-- §2 Catalog
-- =============================================================================

-- "restaurants near an address": bounding-box filter on plain lat/lng
-- (see docs/design/notes/schema-notes.md §6 for the PostGIS upgrade path)
CREATE INDEX IF NOT EXISTS restaurants_lat_lng_idx ON restaurants (lat, lng);

-- availability overrides must point to an item of the restaurant's own brand (D1)
CREATE OR REPLACE FUNCTION check_availability_brand() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM restaurants r
      JOIN menu_items m ON m.brand_id = r.brand_id
     WHERE r.id = NEW.restaurant_id AND m.id = NEW.menu_item_id
  ) THEN
    RAISE EXCEPTION 'menu item % does not belong to the brand of restaurant %',
      NEW.menu_item_id, NEW.restaurant_id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER restaurant_item_availability_brand_check
  BEFORE INSERT OR UPDATE OF restaurant_id, menu_item_id ON restaurant_item_availability
  FOR EACH ROW EXECUTE FUNCTION check_availability_brand();


-- =============================================================================
-- §3 Customer side
-- =============================================================================

-- one default address per user ("Set default address")
CREATE UNIQUE INDEX IF NOT EXISTS delivery_addresses_one_default_uq
  ON delivery_addresses (user_id) WHERE is_default;

-- stale carts (retention, §12)
CREATE INDEX IF NOT EXISTS carts_updated_idx ON carts (updated_at);

-- cart items must belong to the cart restaurant's brand (one restaurant per order)
CREATE OR REPLACE FUNCTION check_cart_item_brand() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_restaurant_brand bigint;
BEGIN
  SELECT r.brand_id INTO v_restaurant_brand
    FROM carts c JOIN restaurants r ON r.id = c.restaurant_id
   WHERE c.id = NEW.cart_id;
  IF v_restaurant_brand IS NULL THEN
    RAISE EXCEPTION 'cart % has no restaurant; set carts.restaurant_id first', NEW.cart_id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM menu_items WHERE id = NEW.menu_item_id AND brand_id = v_restaurant_brand) THEN
    RAISE EXCEPTION 'menu item % is not on the menu of the cart restaurant', NEW.menu_item_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER cart_items_brand_check
  BEFORE INSERT OR UPDATE OF cart_id, menu_item_id ON cart_items
  FOR EACH ROW EXECUTE FUNCTION check_cart_item_brand();


-- =============================================================================
-- §4 Orders
-- =============================================================================

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


-- =============================================================================
-- §5 Dispatch and courier positions
-- =============================================================================

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


-- =============================================================================
-- §6 Cancel requests and incidents
-- =============================================================================

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


-- =============================================================================
-- §7 Payments and plumbing
-- =============================================================================

-- outbox worker: claim unprocessed rows that are due
CREATE INDEX IF NOT EXISTS outbox_unprocessed_idx
  ON outbox (next_attempt_at) WHERE processed_at IS NULL;
-- retention: processed rows older than 7 days
CREATE INDEX IF NOT EXISTS outbox_processed_idx
  ON outbox (processed_at) WHERE processed_at IS NOT NULL;

-- the outbox churns constantly: vacuum it more eagerly than the default
ALTER TABLE outbox SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);


-- =============================================================================
-- §8 Chat
-- =============================================================================

-- one order chat per order
CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_order_chat_uq
  ON conversations (order_id) WHERE type = 'order';

-- one live support chat per customer (open or resolved: a customer reply reopens it, C4)
CREATE UNIQUE INDEX IF NOT EXISTS conversations_one_support_chat_uq
  ON conversations (customer_id) WHERE type = 'support' AND status <> 'closed';

-- C5 close sweep and unread-reply emails
CREATE INDEX IF NOT EXISTS conversations_not_closed_idx
  ON conversations (type, status) WHERE status <> 'closed';


-- =============================================================================
-- §9 Triggers
-- =============================================================================

-- §9.1 updated_at ------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'courier_profiles', 'applications', 'brands', 'restaurants', 'menu_items',
    'restaurant_item_availability', 'delivery_addresses', 'carts', 'cart_items', 'orders',
    'order_cancel_requests', 'platform_settings', 'conversations', 'conversation_reads'
  ] LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t || '_set_updated_at', t);
  END LOOP;
END $$;

-- §9.2 orders: allowed status transitions ---------------------------------------
-- Mirrors docs/design/notes/order-state-machine.md §2.1. Anything else raises check_violation (23514 -> HTTP 409).
CREATE OR REPLACE FUNCTION check_order_transition() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending_payment' THEN
      RAISE EXCEPTION 'orders must be created as pending_payment, got %', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM (VALUES
      ('pending_payment',  'placed'),            -- T3
      ('pending_payment',  'expired'),           -- T4
      ('pending_payment',  'cancelled'),         -- T5, T15
      ('placed',           'accepted'),          -- T6
      ('placed',           'rejected'),          -- T7, T8
      ('placed',           'cancelled'),         -- T9, T15
      ('accepted',         'ready_for_pickup'),  -- T10
      ('accepted',         'picked_up'),         -- T12, T16
      ('accepted',         'cancelled'),         -- T11, T15, T18
      ('ready_for_pickup', 'picked_up'),         -- T12, T16
      ('ready_for_pickup', 'cancelled'),         -- T14, T15, T18
      ('picked_up',        'delivered'),         -- T13, T17
      ('picked_up',        'cancelled')          -- T15
    ) AS allowed(from_status, to_status)
    WHERE allowed.from_status = OLD.status::text AND allowed.to_status = NEW.status::text
  ) THEN
    RAISE EXCEPTION 'order %: transition % -> % is not allowed', OLD.id, OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE TRIGGER orders_transition_guard
  BEFORE INSERT OR UPDATE OF status ON orders
  FOR EACH ROW EXECUTE FUNCTION check_order_transition();

-- §9.3 orders: status history --------------------------------------------------
-- Actor and reason come from the transaction: SET LOCAL app.actor = 'courier:88'; SET LOCAL app.reason = '...';
CREATE OR REPLACE FUNCTION log_order_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO order_status_history (order_id, from_status, to_status, version, actor, reason, at)
  VALUES (
    NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
    NEW.status,
    NEW.version,
    COALESCE(NULLIF(current_setting('app.actor', true), ''), 'system:unknown'),
    NULLIF(current_setting('app.reason', true), ''),
    now()
  );
  RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER orders_status_history_insert
  AFTER INSERT ON orders
  FOR EACH ROW EXECUTE FUNCTION log_order_status();

CREATE OR REPLACE TRIGGER orders_status_history_update
  AFTER UPDATE OF status ON orders
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION log_order_status();

-- §9.4 users: account status history ----------------------------------------
CREATE OR REPLACE FUNCTION log_user_status() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO account_status_history (user_id, from_status, to_status, actor, reason, at)
  VALUES (
    NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
    NEW.status,
    COALESCE(NULLIF(current_setting('app.actor', true), ''), 'system:unknown'),
    NULLIF(current_setting('app.reason', true), ''),
    now()
  );
  RETURN NULL;
END $$;

CREATE OR REPLACE TRIGGER users_status_history_insert
  AFTER INSERT ON users
  FOR EACH ROW EXECUTE FUNCTION log_user_status();

CREATE OR REPLACE TRIGGER users_status_history_update
  AFTER UPDATE OF status ON users
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION log_user_status();


-- =============================================================================
-- §10 Partitioning: order_status_history, monthly on "at" (R12: keep 12 months)
-- =============================================================================
-- schema.dbml declares the columns; this section turns the table into a partitioned
-- table. It only does so while the table is still empty (fresh database).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'order_status_history' AND relkind = 'r') THEN
    IF EXISTS (SELECT 1 FROM order_status_history LIMIT 1) THEN
      RAISE NOTICE 'order_status_history has rows; convert it with a dedicated migration (docs/design/notes/schema-notes.md §7)';
    ELSE
      DROP TABLE order_status_history;
      CREATE TABLE order_status_history (
        id          bigint GENERATED BY DEFAULT AS IDENTITY,
        order_id    bigint       NOT NULL REFERENCES orders (id) ON DELETE RESTRICT,
        from_status order_status,
        to_status   order_status NOT NULL,
        version     int          NOT NULL,
        actor       varchar(64)  NOT NULL,
        reason      varchar(500),
        at          timestamptz  NOT NULL DEFAULT now(),
        PRIMARY KEY (id, at)
      ) PARTITION BY RANGE (at);
      CREATE INDEX order_status_history_order_idx ON order_status_history (order_id, at);
      CREATE TABLE order_status_history_default PARTITION OF order_status_history DEFAULT;
    END IF;
  END IF;
END $$;

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


-- =============================================================================
-- §11 Seeds: platform_settings (R2 values; other timings from the flow decisions)
-- =============================================================================

INSERT INTO platform_settings (key, value, description) VALUES
  ('min_order_minor',                 '2500', 'R2: minimum order subtotal, bani (25 RON)'),
  ('delivery_fee_base_minor',         '700',  'R2: delivery fee up to the base distance, bani (7 RON)'),
  ('delivery_fee_base_km',            '3',    'R2: route km included in the base fee'),
  ('delivery_fee_per_extra_km_minor', '200',  'R2: per started extra km, bani (2 RON)'),
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


-- =============================================================================
-- §12 Retention (R12) – called by the worker service once per hour
-- =============================================================================
-- Deletes in batches so no single statement holds locks for long. Returns rows deleted.

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


-- =============================================================================
-- §13 CHECK constraints
-- =============================================================================
-- DBML cannot declare CHECK constraints, so they all live here. Each one is added
-- only if missing, so the file stays idempotent. Violations raise 23514 (-> 409).

CREATE OR REPLACE FUNCTION add_check_if_missing(p_table regclass, p_name text, p_expr text)
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = p_table AND conname = p_name) THEN
    EXECUTE format('ALTER TABLE %s ADD CONSTRAINT %I CHECK (%s)', p_table, p_name, p_expr);
  END IF;
END $$;

-- users
SELECT add_check_if_missing('users', 'users_deleted_consistent', $c$(status = 'deleted') = (deleted_at IS NOT NULL)$c$);
SELECT add_check_if_missing('users', 'users_approval_roles', $c$status <> 'pending_approval' OR role IN ('courier', 'restaurant_owner')$c$);
SELECT add_check_if_missing('users', 'users_counters_non_negative', $c$token_version >= 0 AND version >= 0$c$);

-- courier_profiles
SELECT add_check_if_missing('courier_profiles', 'courier_profiles_offline_reason', $c$(availability = 'online') = (offline_reason IS NULL)$c$);
SELECT add_check_if_missing('courier_profiles', 'courier_profiles_missed_non_negative', $c$consecutive_missed_offers >= 0$c$);

-- applications
SELECT add_check_if_missing('applications', 'applications_role', $c$role IN ('courier', 'restaurant_owner')$c$);
SELECT add_check_if_missing('applications', 'applications_attempts', $c$attempt_no BETWEEN 1 AND 3$c$);
SELECT add_check_if_missing('applications', 'applications_decided_consistent', $c$(status = 'pending') = (decided_at IS NULL)$c$);
SELECT add_check_if_missing('applications', 'applications_reject_reason', $c$status <> 'rejected' OR reject_reason IS NOT NULL$c$);
SELECT add_check_if_missing('applications', 'applications_restaurant_owner_only', $c$role = 'restaurant_owner' OR restaurant_id IS NULL$c$);

-- email_tokens
SELECT add_check_if_missing('email_tokens', 'email_tokens_expiry_after_creation', $c$expires_at > created_at$c$);

-- brands
SELECT add_check_if_missing('brands', 'brands_private_no_osm_tag', $c$kind = 'chain' OR osm_brand_tag IS NULL$c$);

-- restaurants
SELECT add_check_if_missing('restaurants', 'restaurants_coordinates', $c$lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180$c$);
SELECT add_check_if_missing('restaurants', 'restaurants_timeouts_non_negative', $c$consecutive_timeouts >= 0$c$);
SELECT add_check_if_missing('restaurants', 'restaurants_owned_have_hours', $c$owner_id IS NULL OR opening_hours IS NOT NULL$c$);

-- menu_items
SELECT add_check_if_missing('menu_items', 'menu_items_price_non_negative', $c$price_minor >= 0$c$);
SELECT add_check_if_missing('menu_items', 'menu_items_currency_format', $c$currency ~ '^[A-Z]{3}$'$c$);

-- delivery_addresses
SELECT add_check_if_missing('delivery_addresses', 'delivery_addresses_coordinates', $c$lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180$c$);

-- cart_items
SELECT add_check_if_missing('cart_items', 'cart_items_quantity', $c$quantity BETWEEN 1 AND 50$c$);

-- orders
SELECT add_check_if_missing('orders', 'orders_total_sum', $c$total_minor = subtotal_minor + delivery_fee_minor$c$);
SELECT add_check_if_missing('orders', 'orders_amounts_non_negative', $c$subtotal_minor >= 0 AND delivery_fee_minor >= 0 AND delivery_distance_m >= 0$c$);
SELECT add_check_if_missing('orders', 'orders_currency_format', $c$currency ~ '^[A-Z]{3}$'$c$);
SELECT add_check_if_missing('orders', 'orders_attempts', $c$payment_attempts BETWEEN 0 AND 5 AND capture_attempts >= 0$c$);
SELECT add_check_if_missing('orders', 'orders_dispatch_round', $c$dispatch_round >= 0$c$);
SELECT add_check_if_missing('orders', 'orders_prep_minutes', $c$prep_minutes IS NULL OR (prep_minutes BETWEEN 10 AND 60 AND prep_minutes % 5 = 0)$c$);
SELECT add_check_if_missing('orders', 'orders_no_courier_before_accept', $c$status NOT IN ('pending_payment', 'placed') OR courier_id IS NULL$c$);
SELECT add_check_if_missing('orders', 'orders_placed_fields', $c$status NOT IN ('placed', 'accepted', 'ready_for_pickup', 'picked_up', 'delivered', 'rejected') OR (placed_at IS NOT NULL AND accept_deadline IS NOT NULL)$c$);
SELECT add_check_if_missing('orders', 'orders_accepted_fields', $c$status NOT IN ('accepted', 'ready_for_pickup', 'picked_up', 'delivered') OR (accepted_at IS NOT NULL AND prep_minutes IS NOT NULL AND estimated_ready_at IS NOT NULL AND dispatch_after IS NOT NULL)$c$);
SELECT add_check_if_missing('orders', 'orders_ready_fields', $c$status <> 'ready_for_pickup' OR ready_at IS NOT NULL$c$);
SELECT add_check_if_missing('orders', 'orders_pickup_fields', $c$status NOT IN ('picked_up', 'delivered') OR (courier_id IS NOT NULL AND picked_up_at IS NOT NULL)$c$);
SELECT add_check_if_missing('orders', 'orders_delivered_fields', $c$status <> 'delivered' OR delivered_at IS NOT NULL$c$);
SELECT add_check_if_missing('orders', 'orders_ended_at', $c$(status IN ('delivered', 'cancelled', 'rejected', 'expired')) = (ended_at IS NOT NULL)$c$);
SELECT add_check_if_missing('orders', 'orders_cancelled_by', $c$(status IN ('cancelled', 'rejected', 'expired')) = (cancelled_by IS NOT NULL)$c$);
SELECT add_check_if_missing('orders', 'orders_assignment_consistent', $c$status NOT IN ('accepted', 'ready_for_pickup') OR ((dispatch_state = 'assigned') = (courier_id IS NOT NULL))$c$);
SELECT add_check_if_missing('orders', 'orders_dispatch_started_fields', $c$dispatch_state = 'not_started' OR (dispatch_started_at IS NOT NULL AND dispatch_deadline IS NOT NULL AND dispatch_round >= 1)$c$);
SELECT add_check_if_missing('orders', 'orders_authorized_while_active', $c$status NOT IN ('placed', 'accepted', 'ready_for_pickup', 'picked_up') OR payment_status = 'authorized'$c$);
SELECT add_check_if_missing('orders', 'orders_capture_only_delivered', $c$payment_status NOT IN ('captured', 'capture_failed') OR status = 'delivered'$c$);

-- order_items
SELECT add_check_if_missing('order_items', 'order_items_price_non_negative', $c$unit_price_minor >= 0$c$);
SELECT add_check_if_missing('order_items', 'order_items_quantity', $c$quantity BETWEEN 1 AND 50$c$);
SELECT add_check_if_missing('order_items', 'order_items_line_total', $c$line_total_minor = unit_price_minor * quantity$c$);

-- order_offers
SELECT add_check_if_missing('order_offers', 'order_offers_round', $c$round >= 1$c$);
SELECT add_check_if_missing('order_offers', 'order_offers_expiry_after_offer', $c$expires_at > offered_at$c$);
SELECT add_check_if_missing('order_offers', 'order_offers_responded_consistent', $c$(status = 'pending') = (responded_at IS NULL)$c$);
SELECT add_check_if_missing('order_offers', 'order_offers_decline_reason', $c$decline_reason IS NULL OR status = 'declined'$c$);

-- order_cancel_requests
SELECT add_check_if_missing('order_cancel_requests', 'order_cancel_requests_decided_consistent', $c$(status = 'pending') = (decided_at IS NULL)$c$);

-- order_incidents
SELECT add_check_if_missing('order_incidents', 'order_incidents_category', $c$(type = 'courier_problem') = (category IS NOT NULL)$c$);
SELECT add_check_if_missing('order_incidents', 'order_incidents_scope', $c$(type = 'restaurant_unresponsive') = (order_id IS NULL)$c$);
SELECT add_check_if_missing('order_incidents', 'order_incidents_restaurant_set', $c$restaurant_id IS NOT NULL$c$);
SELECT add_check_if_missing('order_incidents', 'order_incidents_resolved_consistent', $c$resolved_by IS NULL OR resolved_at IS NOT NULL$c$);

-- route_cache
SELECT add_check_if_missing('route_cache', 'route_cache_non_negative', $c$distance_m >= 0 AND duration_s >= 0$c$);

-- courier_positions
SELECT add_check_if_missing('courier_positions', 'courier_positions_coordinates', $c$lat BETWEEN -90 AND 90 AND lng BETWEEN -180 AND 180$c$);

-- outbox
SELECT add_check_if_missing('outbox', 'outbox_attempts_non_negative', $c$attempts >= 0$c$);

-- conversations
SELECT add_check_if_missing('conversations', 'conversations_order_fields', $c$type <> 'order' OR (order_id IS NOT NULL AND restaurant_id IS NOT NULL)$c$);
SELECT add_check_if_missing('conversations', 'conversations_support_fields', $c$type <> 'support' OR restaurant_id IS NULL$c$);
SELECT add_check_if_missing('conversations', 'conversations_closed_consistent', $c$(status = 'closed') = (closed_at IS NOT NULL)$c$);
SELECT add_check_if_missing('conversations', 'conversations_resolved_consistent', $c$status <> 'resolved' OR resolved_at IS NOT NULL$c$);
SELECT add_check_if_missing('conversations', 'conversations_last_seq', $c$last_seq >= 0$c$);

-- messages
SELECT add_check_if_missing('messages', 'messages_seq', $c$seq >= 1$c$);
SELECT add_check_if_missing('messages', 'messages_body_length', $c$char_length(body) BETWEEN 1 AND 2000$c$);
SELECT add_check_if_missing('messages', 'messages_system_sender', $c$(kind = 'system') = (sender_id IS NULL)$c$);
SELECT add_check_if_missing('messages', 'messages_client_id_for_text', $c$kind = 'system' OR client_msg_id IS NOT NULL$c$);

-- conversation_reads
SELECT add_check_if_missing('conversation_reads', 'conversation_reads_seq', $c$last_read_seq >= 0$c$);
