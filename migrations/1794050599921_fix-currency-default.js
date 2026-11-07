/**
 * Money is stored in euro cents, currency EUR.
 * Migrations 3 (catalog) and 6 (orders) now declare default 'EUR', but databases migrated from
 * older versions of those files still have 'RON' or 'EURO' (which does not fit char(3) nor the
 * ^[A-Z]{3}$ CHECK). This repairs them; on a fresh database it changes nothing.
 * Existing rows are not touched.
 */

exports.up = (pgm) => {
  pgm.sql(`
ALTER TABLE menu_items ALTER COLUMN currency SET DEFAULT 'EUR';
ALTER TABLE orders     ALTER COLUMN currency SET DEFAULT 'EUR';
`);
};

// No down: going back to 'EURO' / 'RON' would only bring the bug back.
exports.down = () => {};
