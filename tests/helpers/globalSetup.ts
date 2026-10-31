import dotenv from 'dotenv';
import { Client } from 'pg';

// Runs once before all test files. If anything here throws, Jest aborts the whole run.
export default async function globalSetup(): Promise<void> {
    process.env.NODE_ENV = 'test';
    dotenv.config({ quiet: true });

    // Required here, after NODE_ENV is set: the config reads process.env when it is loaded.
    const dbConfig = require('../../config/database');
    const client = new Client(dbConfig);
    await client.connect();

    try {
        const { rows } = await client.query('SELECT current_database() AS db');
        const db: string = rows[0].db;
        if (!db.endsWith('_test')) {
            throw new Error(`Refusing to run tests against database "${db}": its name must end in _test.`);
        }

        const schema = await client.query(`SELECT to_regclass('public.users') AS users`);
        if (!schema.rows[0].users) {
            throw new Error(`Database "${db}" has no schema. Run: npm run migrate:test:up`);
        }
    } finally {
        await client.end();
    }
}
