/**
 * M9b robot couriers, step 2 of 2 (design: docs/design/notes/future-ideas.md #2).
 * - courier_profiles.is_robot: robot accounts (seed robot1..robot6), never real couriers.
 *   CHECK: is_robot exactly when the vehicle is a robot type, so a human can never get a robot vehicle or the reverse.
 * - orders.delivery_mode: what the customer chose at checkout. Existing orders become 'human' (the default).
 * - Settings for the fee, the vehicle choice and the idle robots.
 */

exports.shorthands = undefined;

const SETTINGS = [
  ['robot_max_distance_m', '2000', 'Sidewalk robot up to this route distance (m); beyond it a robot car delivers.'],
  ['robot_fee_discount_pct', '50', 'Delivery fee discount (%) for a sidewalk robot delivery.'],
  ['robot_car_fee_discount_pct', '30', 'Delivery fee discount (%) for a robot car delivery.'],
  ['robot_idle_offline_s', '300', 'A started robot with no order for this long goes offline (s).'],
];

exports.up = (pgm) => {
  pgm.addColumn('courier_profiles', {
    is_robot: { type: 'boolean', notNull: true, default: false },
  });
  pgm.addConstraint('courier_profiles', 'courier_profiles_robot_vehicle_check', {
    check: `is_robot = (vehicle_type IN ('robot', 'robot_car'))`,
  });

  pgm.createType('delivery_mode', ['human', 'robot']);
  pgm.addColumn('orders', {
    delivery_mode: { type: 'delivery_mode', notNull: true, default: 'human' },
  });

  for (const [key, value, description] of SETTINGS) {
    pgm.sql(`
INSERT INTO platform_settings (key, value, description)
VALUES ('${key}', '${value}', '${description}')
ON CONFLICT (key) DO NOTHING;`);
  }
};

exports.down = (pgm) => {
  pgm.sql(`DELETE FROM platform_settings WHERE key IN (${SETTINGS.map(([key]) => `'${key}'`).join(', ')});`);
  pgm.dropColumn('orders', 'delivery_mode');
  pgm.dropType('delivery_mode');
  pgm.dropConstraint('courier_profiles', 'courier_profiles_robot_vehicle_check');
  pgm.dropColumn('courier_profiles', 'is_robot');
};
