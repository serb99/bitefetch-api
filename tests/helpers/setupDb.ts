import { pool, assertTestDatabase, resetAccountTables } from './db';

beforeAll(assertTestDatabase);

beforeEach(async () => {
    await resetAccountTables();
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
