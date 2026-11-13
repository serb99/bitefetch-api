import { Client, PoolClient } from 'pg';
import { pool } from '../database/pool';
import { withTransaction } from '../database/transaction'
import { AppError } from '../errors/AppError';
import type { CreateAddressInput, UpdateAddressInput } from '../schemas/addressSchema';
import { user } from '../../config/database';

const MAX_ADDRESSES = 10;

const ADDRESS_COLUMNS = `id, label, street, details, city, lat, lng, is_default AS "isDefault"`;

type Address = {
    id: string;
    label: string | null;
    street: string;
    details: string | null;
    city: string;
    lat: number;
    lng: number;
    isDefault: boolean;
};

const COLUMN_BY_FIELD = {
    label: 'label',
    street: 'street',
    details: 'details',
    city: 'city',
    lat: 'lat',
    lng: 'lng',
} as const;

//one customer changes their addresses one at a time
function lockAddresses(client: PoolClient, userId: string) {
    return client.query('SELECT pg_advisory_xact_lock(hashtext($1::text))', [`addresses:${userId}`]);
}

function notFound(): AppError {
    return new AppError(404, 'ADDRESS_NOT_FOUND', 'Address not found');
}

async function listAddresses(userId: string): Promise<Address[]>{
    const { rows } = await pool.query<Address>(
        `SELECT ${ADDRESS_COLUMNS} FROM delivery_addresses
            WHERE user_id = $1
            ORDER BY is_default DESC, created_at DESC`,
        [userId]
    );
    return rows;
}

async function createAddress(userId: string, input: CreateAddressInput): Promise<Address> {
    return withTransaction(async (client) => {
        await lockAddresses(client, userId);

        const counted = await client.query<{ count: string }>(
            `SELECT count(*) FROM delivery_addresses WHERE user_id = $1`,
            [userId]
        );
        const existing = Number(counted.rows[0].count);
        if (existing >= MAX_ADDRESSES) {
            throw new AppError(409, 'ADDRESS_LIMIT', `You can save at most ${MAX_ADDRESSES} addresses`);
        }

        const { rows } = await client.query<Address>(
            `INSERT INTO delivery_addresses (user_id, label, street, details, city, lat, lng, is_default)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             RETURNING ${ADDRESS_COLUMNS}`,
             [userId, input.label ?? null, input.street, input.details ?? null,
                input.city, input.lat, input.lng, existing === 0 // the first one is the default
             ]
            );

        return rows[0];
    }, `user:${userId}`, 'create address');
}

async function updateAddress(userId: string, addressId: string, input: UpdateAddressInput): Promise<Address> {
    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [field, value] of Object.entries(input)) {
        const column = COLUMN_BY_FIELD[field as keyof typeof COLUMN_BY_FIELD];
        values.push(value);
        sets.push(`${column} = $${values.length}`);
    }
    values.push(addressId, userId);

    const { rows } = await pool.query<Address>(
        `UPDATE delivery_addresses SET ${sets.join(', ')}
          WHERE id = $${values.length - 1} AND user_id = $${values.length}
          RETURNING ${ADDRESS_COLUMNS}`,
          values
    );
    if (!rows[0]) {
        throw notFound();
    }
    return rows[0];
}

async function setDefaultAddress(userId: string, addressId: string): Promise<Address> {
    return withTransaction(async (client) => {
        await lockAddresses(client, userId);

        //clear the old default (the unique index allows only one)
        await client.query(
            `UPDATE delivery_addresses SET is_default = false WHERE user_id = $1 AND is_default`,
            [userId]
        );
        const { rows } = await client.query<Address>(
            `UPDATE delivery_addresses SET is_default = true
              WHERE id = $1 AND user_id = $2
              RETURNING ${ADDRESS_COLUMNS}`,
              [addressId, userId]
        );
        if (!rows[0]) {
            throw notFound(); // the rollback also undoes the clearing above
        }
        return rows[0];
    }, `user:${userId}`, 'set default address');
}

async function deleteAddress(userId: string, addressId: string): Promise<void> {
    return withTransaction(async (client) => {
        await lockAddresses(client, userId);

        const deleted = await client.query<{ isDefault: boolean }>(
            `DELETE FROM delivery_addresses WHERE id = $1 AND user_id = $2
             RETURNING is_default AS "isDefault"`,
            [addressId, userId]
        );
        if (!deleted.rows[0]) {
            throw notFound();
        }

        // the default was deleted: the newest remaining address becomes the default (none left: nothing to do)
        if (deleted.rows[0].isDefault) {
            await client.query(
                `UPDATE delivery_addresses SET is_default = true
                  WHERE id = (SELECT id FROM delivery_addresses
                               WHERE user_id = $1
                               ORDER BY created_at DESC, id DESC
                               LIMIT 1)`,
                [userId]
            );
        }
    }, `user:${userId}`, 'delete address');
}

export { listAddresses, createAddress, updateAddress, setDefaultAddress, deleteAddress };
export type { Address };