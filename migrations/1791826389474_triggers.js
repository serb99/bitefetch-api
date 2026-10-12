/**
 * Migration 10 - triggers (constraints.sql sections 2, 3 and 9).
 *
 * - restaurant_item_availability and cart_items: the menu item must belong to the right brand.
 * - updated_at: set automatically on every UPDATE of 15 tables.
 * - orders: transition guard (only allowed status changes) and status history (a row per change).
 * - users: account status history (a row per change).
 * The history triggers read the actor and the reason from the transaction:
 *   SET LOCAL app.actor = 'courier:88'; SET LOCAL app.reason = '...';
 *
 * Source of truth: database/constraints.sql.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.sql(`
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
-- Mirrors docs/order-state-machine.md §2.1. Anything else raises check_violation (23514 -> HTTP 409).
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
`);
};

exports.down = (pgm) => {
  const updatedAtTables = [
    'users',
    'courier_profiles',
    'applications',
    'brands',
    'restaurants',
    'menu_items',
    'restaurant_item_availability',
    'delivery_addresses',
    'carts',
    'cart_items',
    'orders',
    'order_cancel_requests',
    'platform_settings',
    'conversations',
    'conversation_reads',
  ];
  for (const t of updatedAtTables) {
    pgm.sql(`DROP TRIGGER IF EXISTS ${t}_set_updated_at ON ${t};`);
  }
  pgm.sql('DROP TRIGGER IF EXISTS users_status_history_update ON users;');
  pgm.sql('DROP TRIGGER IF EXISTS users_status_history_insert ON users;');
  pgm.sql('DROP TRIGGER IF EXISTS orders_status_history_update ON orders;');
  pgm.sql('DROP TRIGGER IF EXISTS orders_status_history_insert ON orders;');
  pgm.sql('DROP TRIGGER IF EXISTS orders_transition_guard ON orders;');
  pgm.sql('DROP TRIGGER IF EXISTS cart_items_brand_check ON cart_items;');
  pgm.sql('DROP TRIGGER IF EXISTS restaurant_item_availability_brand_check ON restaurant_item_availability;');
  pgm.sql('DROP FUNCTION IF EXISTS check_availability_brand(), check_cart_item_brand(), set_updated_at(), check_order_transition(), log_order_status(), log_user_status();');
};