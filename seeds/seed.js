/**
 * Seed script: development data for BiteFetch.
 *
 *   npm run seed                 -> seeds bitefetch_db (DB_NAME)
 *   npm run seed -- --test       -> seeds bitefetch_db_test (DB_NAME_TEST)
 *   npm run seed -- --prod-timers -> keeps the production timers in platform_settings
 *
 * Creates: 1 admin, 2 customers (with a default address), 2 couriers, 2 restaurant owners,
 * 2 brands (one private, one chain), 3 restaurants in Cluj-Napoca and a menu for each brand.
 * Also shortens the timers in platform_settings so an order can be tested in minutes.
 *
 * Safe to run more than once: rows that already exist are left alone.
 * Refuses to run when NODE_ENV=production.
 * All dev accounts use the same password (see PASSWORD below).
 */

const args = process.argv.slice(2);
if (args.includes('--test')) process.env.NODE_ENV = 'test';

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed: NODE_ENV=production.');
  process.exit(1);
}

require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const dbConfig = require('../config/database');

let bcrypt;
try {
  bcrypt = require('bcrypt');
} catch {
  try {
    bcrypt = require('bcryptjs');
  } catch {
    console.error('Install a hashing library first: npm install bcrypt (or bcryptjs).');
    process.exit(1);
  }
}

const PASSWORD = 'Password123!';
const DOMAIN = 'bitefetch.local';

// ---------------------------------------------------------------------------------------------
// Data (coordinates are approximate points around the center of Cluj-Napoca; money is in euro cents)
// ---------------------------------------------------------------------------------------------

const USERS = [
  { key: 'admin', email: `admin@${DOMAIN}`, role: 'admin', full_name: 'Admin BiteFetch', phone: '+40700000001' },
  { key: 'ana', email: `ana@${DOMAIN}`, role: 'customer', full_name: 'Ana Popescu', phone: '+40700000002' },
  { key: 'bob', email: `bob@${DOMAIN}`, role: 'customer', full_name: 'Bogdan Ionescu', phone: '+40700000003' },
  { key: 'rider1', email: `courier1@${DOMAIN}`, role: 'courier', full_name: 'Radu Courier', phone: '+40700000004' },
  { key: 'rider2', email: `courier2@${DOMAIN}`, role: 'courier', full_name: 'Elena Courier', phone: '+40700000005' },
  { key: 'owner1', email: `maria@${DOMAIN}`, role: 'restaurant_owner', full_name: 'Maria Rusu', phone: '+40700000006' },
  { key: 'owner2', email: `ion@${DOMAIN}`, role: 'restaurant_owner', full_name: 'Ion Vasilescu', phone: '+40700000007' },
];

const COURIERS = [
  { user: 'rider1', vehicle_type: 'bike' },
  { user: 'rider2', vehicle_type: 'scooter' },
];

const ADDRESSES = [
  { user: 'ana', label: 'Home', street: 'Strada Observatorului 20', details: 'Bl. A2, ap. 14', city: 'Cluj-Napoca', lat: 46.7600, lng: 23.5760 },
  { user: 'bob', label: 'Home', street: 'Strada Dorobanților 30', details: null, city: 'Cluj-Napoca', lat: 46.7770, lng: 23.5930 },
];

const BRANDS = [
  { key: 'casa', name: 'Casa Ardeleană', kind: 'private', osm_brand_tag: null },
  { key: 'napoli', name: 'Pizza Napoli', kind: 'chain', osm_brand_tag: 'Pizza Napoli' },
];

const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const hours = (open, close) => Object.fromEntries(WEEK.map((d) => [d, [[open, close]]]));

const RESTAURANTS = [
  { key: 'casa1', brand: 'casa', owner: 'owner1', name: 'Casa Ardeleană', address: 'Strada Napoca 10, Cluj-Napoca', lat: 46.7712, lng: 23.5918, phone: '+40264000001', opening_hours: hours('10:00', '23:00') },
  { key: 'napoli1', brand: 'napoli', owner: 'owner2', name: 'Pizza Napoli Centru', address: 'Bulevardul Eroilor 8, Cluj-Napoca', lat: 46.7692, lng: 23.5917, phone: '+40264000002', opening_hours: hours('11:00', '23:30') },
  // a second location of the chain that nobody has claimed yet (no owner, so it cannot take orders)
  { key: 'napoli2', brand: 'napoli', owner: null, name: 'Pizza Napoli Gară', address: 'Piața Gării 1, Cluj-Napoca', lat: 46.7867, lng: 23.5860, phone: null, opening_hours: hours('11:00', '23:30') },
];

const MENUS = {
  casa: [
    ['Varză à la Cluj', 'Layered cabbage, minced pork and rice baked with sour cream', 850, 'Main dishes'],
    ['Ciorbă de văcuță', 'Beef soup with vegetables and lovage', 600, 'Soups'],
    ['Ciorbă de legume', 'Vegetable soup', 450, 'Soups'],
    ['Tochitură ardelenească', 'Pork stew with sausage, polenta and a fried egg', 900, 'Main dishes'],
    ['Papanași cu smântână', 'Fried cheese donuts with sour cream and jam', 550, 'Desserts'],
    ['Limonadă de casă', 'Homemade lemonade 400 ml', 300, 'Drinks'],
    ['Apă plată 0.5 L', null, 150, 'Drinks'],
  ],
  napoli: [
    ['Pizza Margherita', 'Tomato sauce, mozzarella, basil', 800, 'Pizza'],
    ['Pizza Quattro Formaggi', 'Four cheeses', 1050, 'Pizza'],
    ['Pizza Diavola', 'Spicy salami, mozzarella, chili', 1000, 'Pizza'],
    ['Pizza Prosciutto e Funghi', 'Ham and mushrooms', 1000, 'Pizza'],
    ['Lasagna', 'Beef ragù, béchamel, parmesan', 900, 'Pasta'],
    ['Tiramisu', null, 450, 'Desserts'],
    ['Cola 0.33 L', null, 200, 'Drinks'],
    ['Apă minerală 0.5 L', null, 150, 'Drinks'],
  ],
};

// Short timers for development (seconds). Production values stay in migration 11.
const DEV_TIMERS = {
  payment_window_s: 120,
  accept_window_s: 60,
  offer_timeout_s: 15,
  dispatch_deadline_s: 180,
  reconcile_after_s: 30,
  second_round_after_s: 60,
  dispatch_lead_s: 60,
  kitchen_late_after_s: 120,
  delivery_overdue_after_s: 300,
  customer_unreachable_wait_s: 60,
};

// ---------------------------------------------------------------------------------------------

async function main() {
  const client = new Client(dbConfig);
  await client.connect();
  const created = { users: 0, brands: 0, restaurants: 0, menu_items: 0, addresses: 0 };

  try {
    await client.query('BEGIN');
    // the status-history trigger reads these
    await client.query(`SET LOCAL app.actor = 'seed'`);
    await client.query(`SET LOCAL app.reason = 'dev seed'`);

    // users + courier profiles
    const userId = {};
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    for (const u of USERS) {
      const found = await client.query('SELECT id FROM users WHERE lower(email) = lower($1)', [u.email]);
      if (found.rows[0]) {
        userId[u.key] = found.rows[0].id;
        continue;
      }
      const res = await client.query(
        `INSERT INTO users (email, email_verified_at, password_hash, role, status, full_name, phone)
         VALUES ($1, now(), $2, $3, 'active', $4, $5) RETURNING id`,
        [u.email, passwordHash, u.role, u.full_name, u.phone],
      );
      userId[u.key] = res.rows[0].id;
      created.users++;
    }
    for (const c of COURIERS) {
      await client.query(
        `INSERT INTO courier_profiles (user_id, vehicle_type) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`,
        [userId[c.user], c.vehicle_type],
      );
    }

    // delivery addresses (one default per customer)
    for (const a of ADDRESSES) {
      const found = await client.query('SELECT id FROM delivery_addresses WHERE user_id = $1 AND street = $2', [userId[a.user], a.street]);
      if (found.rows[0]) continue;
      await client.query(
        `INSERT INTO delivery_addresses (user_id, label, street, details, city, lat, lng, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOT EXISTS (SELECT 1 FROM delivery_addresses WHERE user_id = $1 AND is_default))`,
        [userId[a.user], a.label, a.street, a.details, a.city, a.lat, a.lng],
      );
      created.addresses++;
    }

    // brands
    const brandId = {};
    for (const b of BRANDS) {
      const found = await client.query('SELECT id FROM brands WHERE name = $1', [b.name]);
      if (found.rows[0]) {
        brandId[b.key] = found.rows[0].id;
        continue;
      }
      const res = await client.query('INSERT INTO brands (name, kind, osm_brand_tag) VALUES ($1, $2, $3) RETURNING id', [b.name, b.kind, b.osm_brand_tag]);
      brandId[b.key] = res.rows[0].id;
      created.brands++;
    }

    // restaurants
    for (const r of RESTAURANTS) {
      const found = await client.query('SELECT id FROM restaurants WHERE brand_id = $1 AND name = $2', [brandId[r.brand], r.name]);
      if (found.rows[0]) continue;
      await client.query(
        `INSERT INTO restaurants (brand_id, owner_id, name, address, lat, lng, phone, opening_hours)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [brandId[r.brand], r.owner ? userId[r.owner] : null, r.name, r.address, r.lat, r.lng, r.phone, JSON.stringify(r.opening_hours)],
      );
      created.restaurants++;
    }

    // menus (one per brand; sort_order follows the list order)
    for (const [brandKey, items] of Object.entries(MENUS)) {
      let order = 0;
      for (const [name, description, price, category] of items) {
        order += 10;
        const found = await client.query('SELECT id FROM menu_items WHERE brand_id = $1 AND name = $2', [brandId[brandKey], name]);
        if (found.rows[0]) continue;
        await client.query(
          `INSERT INTO menu_items (brand_id, name, description, price_minor, category, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [brandId[brandKey], name, description, price, category, order],
        );
        created.menu_items++;
      }
    }

    // dev timers
    let timers = 'production timers kept';
    if (!args.includes('--prod-timers')) {
      for (const [key, value] of Object.entries(DEV_TIMERS)) {
        await client.query('UPDATE platform_settings SET value = $2::jsonb WHERE key = $1', [key, JSON.stringify(value)]);
      }
      timers = 'dev timers applied (short, for manual testing)';
    }

    await client.query('COMMIT');

    console.log(`Seeded database "${dbConfig.database}": ${timers}.`);
    console.log('Created now:', JSON.stringify(created));
    console.log(`\nLogin (password for all: ${PASSWORD})`);
    for (const u of USERS) console.log(`  ${u.role.padEnd(17)} ${u.email}`);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});