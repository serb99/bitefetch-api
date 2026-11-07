/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    // Only the new integration tests. The old Phase 2 tests are not picked up.
    testMatch: ['<rootDir>/tests/integration/**/*.test.ts', '<rootDir>/tests/unit/**/*.test.ts'],
    transform: {
        '^.+\\.ts$': ['@swc/jest', {
            jsc: { parser: { syntax: 'typescript' }, target: 'es2022' },
            module: { type: 'commonjs' },
        }],
    },
    // Aborts the run unless the database name ends in _test.
    globalSetup: '<rootDir>/tests/helpers/globalSetup.ts',
    // Env vars must be set before src/ is imported (pool, jwt and logger read them at load time).
    setupFiles: ['<rootDir>/tests/helpers/env.ts'],
    // Cleans the account tables before each test and closes the pool after each file.
    setupFilesAfterEnv: ['<rootDir>/tests/helpers/setupDb.ts'],
    // All files share one database: never run them in parallel.
    maxWorkers: 1,
};
