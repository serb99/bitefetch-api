import { pool } from './pool';
import { PoolClient } from 'pg';
import { logger } from '../logger';

async function withTransaction<T>(
    fn: (client: PoolClient) => Promise<T>,
    actor: string,
    reason: string
): Promise<T> {

    const client = await pool.connect();
    let broken = false;

    try{
        await client.query('BEGIN');
        await client.query('SELECT set_config($1, $2, true)', ['app.actor', actor]);
        await client.query('SELECT set_config($1, $2, true)', ['app.reason', reason]);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    }
    catch(err){
        try {
            await client.query('ROLLBACK');
        }
        catch(rollbackErr){
            logger.error({ err: rollbackErr }, 'Error rolling back transaction');
            broken = true;
        }
        throw err;
    }
    finally{
        client.release(broken);
    }
}

export { withTransaction };