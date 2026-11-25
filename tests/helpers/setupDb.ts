import { pool, assertTestDatabase, resetAccountTables } from './db';
import { clearSettingsCache } from '../../src/services/settingsService';

beforeAll(async () => {
    await assertTestDatabase();
    // The checkout guard "a fresh courier within 10 km" is off for the tests: most of them check out with no
    // courier around. tests/integration/unhappy/checkoutCourierGuard switches it on (setSetting) and back.
    await pool.query(`UPDATE platform_settings SET value = '0'::jsonb WHERE key = 'checkout_courier_check'`);
});

beforeEach(async () => {
    await resetAccountTables();
    clearSettingsCache();
    // Activation and reset links are only printed. Silence them and keep them readable
    // through the mock (see lastActivationToken / lastResetToken in ./http).
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
});

afterAll(async () => {
    await pool.end();
});
