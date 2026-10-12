require('dotenv').config();
const db = require('./database');

module.exports = {
    ...db,
    dir: 'migrations',
    migrationsTable: 'pgmigrations',
};