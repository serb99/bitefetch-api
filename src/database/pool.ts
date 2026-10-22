import { Pool } from 'pg';
import dbConfig from '../../config/database';
import { logger } from '../logger';

const pool = new Pool(dbConfig);
pool.on('error', (err) => logger.error({ err }, 'Unexpected error on idle database client'));

export { pool };