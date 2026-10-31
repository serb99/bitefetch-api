import dotenv from 'dotenv';

// Runs in every test file before src/ is imported.
process.env.NODE_ENV = 'test';          // config/database.js then picks DB_NAME_TEST
dotenv.config({ quiet: true });         // does not override the values set here
process.env.LOG_LEVEL = 'silent';
// Off by default; tests/integration/auth/rateLimits.test.ts turns it back on.
process.env.RATE_LIMIT_DISABLED = 'true';
