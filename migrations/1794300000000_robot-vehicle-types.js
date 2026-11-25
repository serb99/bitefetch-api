/**
 * M9b robot couriers, step 1 of 2: the two robot vehicle types.
 *   robot     = sidewalk robot (about 6 km/h, routes up to robot_max_distance_m)
 *   robot_car = autonomous car (car ETA x 1.25, longer routes)
 *
 * Its own migration WITHOUT a transaction: Postgres refuses to use a new enum value inside the transaction
 * that added it ("unsafe use of new value"), so the CHECK and the seed in the next migration would fail.
 * IF NOT EXISTS makes a re-run after a half-done attempt safe (no transaction rolls it back).
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  pgm.noTransaction();
  pgm.sql(`ALTER TYPE vehicle_type ADD VALUE IF NOT EXISTS 'robot'`);
  pgm.sql(`ALTER TYPE vehicle_type ADD VALUE IF NOT EXISTS 'robot_car'`);
};

// Postgres cannot drop a value from an enum. Rebuilding the type would mean rewriting every column that uses
// it, for no gain: unused values are harmless. 1794300000001 down removes everything that uses them.
exports.down = () => {};
