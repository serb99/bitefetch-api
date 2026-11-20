import dotenv from 'dotenv';

// Runs in every test file before src/ is imported.
process.env.NODE_ENV = 'test';          // config/database.js then picks DB_NAME_TEST
dotenv.config({ quiet: true });         // does not override the values set here
process.env.LOG_LEVEL = 'silent';
// Off by default; tests/integration/auth/rateLimits.test.ts turns it back on.
process.env.RATE_LIMIT_DISABLED = 'true';
process.env.FRONTEND_URL = 'http://localhost:8080';
// No 1.1 s gap between (mocked) Nominatim calls; osmSearch.test.ts checks the throttle separately.
process.env.OSM_MIN_GAP_MS = '0';
// Same for the (mocked) OSRM routing calls.
process.env.OSRM_MIN_GAP_MS = '0';
// Stripe is faked in tests (tests/helpers/stripeMock.ts). These only make sure that nothing can reach
// the real sandbox even if the mock were missing, and that the webhook secret is the test one.
process.env.STRIPE_SECRET_KEY = 'sk_test_never_used';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_bitefetch';
