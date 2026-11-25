/**
 * Checkout guard "a fresh courier within 10 km": block the checkout when nobody could deliver.
 * As a platform setting so it can be switched off: 1 = checkout refuses with 409 NO_COURIER_NEARBY, 0 = no check.
 * The test database sets it to 0 in tests/helpers/setupDb.ts (most tests check out with no courier around).
 */

exports.up = (pgm) => {
  pgm.sql(`
INSERT INTO platform_settings (key, value, description) VALUES
  ('checkout_courier_check', '1', '1 = checkout needs a fresh online courier within 10 km, 0 = off')
ON CONFLICT (key) DO NOTHING;
`);
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM platform_settings WHERE key = 'checkout_courier_check';`);
};
