import type { PoolClient } from 'pg';
import { pool } from '../../helpers/db';
import { mockRoute } from '../../helpers/customer';
import { pendingOrder } from '../../helpers/payments';
import { createUser } from '../../helpers/users';

// The DB guard (orders_transition_guard, migration 9) against the transition table in
// docs/design/notes/order-state-machine.md §2.1. Tested straight in SQL, so it also covers code paths
// that do not exist yet (M7 courier, M11 admin): whatever the service does, Postgres refuses any other pair.

const STATUSES = [
    'pending_payment', 'placed', 'accepted', 'ready_for_pickup', 'picked_up',
    'delivered', 'cancelled', 'rejected', 'expired',
] as const;
type Status = typeof STATUSES[number];

// §2.1, by pair. Several T share a pair (the guard checks pairs, not actors).
const ALLOWED: Record<Status, Status[]> = {
    pending_payment: ['placed', 'expired', 'cancelled'],      // T3, T4, T5/T15
    placed: ['accepted', 'rejected', 'cancelled'],             // T6, T7/T8, T9/T15
    accepted: ['ready_for_pickup', 'picked_up', 'cancelled'],  // T10, T12/T16, T11/T15/T18
    ready_for_pickup: ['picked_up', 'cancelled'],              // T12/T16, T14/T15/T18
    picked_up: ['delivered', 'cancelled'],                     // T13/T17, T15
    delivered: [],
    cancelled: [],
    rejected: [],
    expired: [],
};

// How to reach each status from pending_payment through allowed steps only.
const PATH: Record<Status, Status[]> = {
    pending_payment: [],
    placed: ['placed'],
    accepted: ['placed', 'accepted'],
    ready_for_pickup: ['placed', 'accepted', 'ready_for_pickup'],
    picked_up: ['placed', 'accepted', 'picked_up'],
    delivered: ['placed', 'accepted', 'picked_up', 'delivered'],
    cancelled: ['cancelled'],
    rejected: ['placed', 'rejected'],
    expired: ['expired'],
};

// Sets the status plus the columns the CHECK constraints ask for in that status, so an allowed pair
// really succeeds (and a refusal can only come from the guard, which runs BEFORE the row checks).
function setFor(to: Status): string {
    switch (to) {
        case 'pending_payment': return `status = 'pending_payment'`;
        case 'placed': return `status = 'placed', placed_at = now(), accept_deadline = now() + interval '5 minutes', payment_status = 'authorized'`;
        case 'accepted': return `status = 'accepted', accepted_at = now(), prep_minutes = 20, estimated_ready_at = now() + interval '20 minutes', dispatch_after = now()`;
        case 'ready_for_pickup': return `status = 'ready_for_pickup', ready_at = now()`;
        case 'picked_up': return `status = 'picked_up', courier_id = $2, picked_up_at = now()`;
        case 'delivered': return `status = 'delivered', delivered_at = now(), ended_at = now()`;
        case 'cancelled':
        case 'rejected':
        case 'expired':
            return `status = '${to}', cancelled_by = 'system', cancel_reason = 'guard_test', ended_at = now()`;
    }
}

async function moveTo(client: PoolClient, orderId: string, courierId: string, to: Status): Promise<void> {
    const sql = setFor(to);
    const params = sql.includes('$2') ? [orderId, courierId] : [orderId];
    await client.query(`UPDATE orders SET ${sql} WHERE id = $1`, params);
}

// Tries from → to inside a savepoint and rolls it back. null = allowed, otherwise the error message.
async function tryMove(client: PoolClient, orderId: string, courierId: string, to: Status): Promise<string | null> {
    await client.query('SAVEPOINT try_move');
    try {
        await moveTo(client, orderId, courierId, to);
        return null;
    } catch (err) {
        return (err as Error).message;
    } finally {
        await client.query('ROLLBACK TO SAVEPOINT try_move');
    }
}

// Runs fn in a transaction that is always rolled back: the matrix never leaves rows behind.
async function inRolledBackTransaction(fn: (client: PoolClient) => Promise<void>): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await fn(client);
    } finally {
        await client.query('ROLLBACK');
        client.release();
    }
}

beforeEach(() => {
    mockRoute(3001);
});

describe('orders_transition_guard: every pair of the state machine', () => {
    it('the table has 13 allowed pairs and 59 refused ones (9 x 9 statuses minus 9 self-loops)', () => {
        const allowed = STATUSES.flatMap((from) => ALLOWED[from]);
        expect(allowed).toHaveLength(13);
        expect(STATUSES.length * STATUSES.length - STATUSES.length - allowed.length).toBe(59);
    });

    it.each(STATUSES)('from %s: exactly the allowed targets pass, every other one is refused by the guard', async (from) => {
        const { order } = await pendingOrder();
        const courier = await createUser({ role: 'courier' });

        await inRolledBackTransaction(async (client) => {
            for (const step of PATH[from]) {
                await moveTo(client, order.id, courier.id, step);
            }

            for (const to of STATUSES) {
                if (to === from) continue;
                const error = await tryMove(client, order.id, courier.id, to);
                if (ALLOWED[from].includes(to)) {
                    expect({ to, error }).toEqual({ to, error: null });
                } else {
                    expect({ to, error }).toEqual({ to, error: `order ${order.id}: transition ${from} -> ${to} is not allowed` });
                }
            }
        });
    });

    it('a refused pair surfaces as SQLSTATE 23514 (check_violation), which the API maps to 409', async () => {
        const { order } = await pendingOrder();

        await expect(pool.query(`UPDATE orders SET status = 'delivered' WHERE id = $1`, [order.id]))
            .rejects.toMatchObject({ code: '23514' });
        const { rows } = await pool.query(`SELECT status FROM orders WHERE id = $1`, [order.id]);
        expect(rows[0].status).toBe('pending_payment');
    });

    it('T2: a status that does not change (pending_payment → pending_payment) passes', async () => {
        const { order } = await pendingOrder();

        await inRolledBackTransaction(async (client) => {
            await expect(client.query(`UPDATE orders SET status = 'pending_payment', payment_attempts = 1 WHERE id = $1`, [order.id]))
                .resolves.toMatchObject({ rowCount: 1 });
        });
    });

    it('T1: an order can only be created as pending_payment', async () => {
        const { order } = await pendingOrder();
        // A copy of the real row with a new id, code and key, so only the status differs.
        const copy = (status: Status) => `
            INSERT INTO orders OVERRIDING SYSTEM VALUE
            SELECT (jsonb_populate_record(NULL::orders, to_jsonb(o) || jsonb_build_object(
                'id', o.id + 1000000, 'order_code', 'BF-ZZZZZ', 'idempotency_key', 'guard-copy',
                'stripe_payment_intent_id', NULL, 'status', '${status}',
                'placed_at', now(), 'accept_deadline', now(), 'payment_status', 'authorized'))).*
              FROM orders o WHERE o.id = $1`;

        await inRolledBackTransaction(async (client) => {
            await client.query('SAVEPOINT s');
            await expect(client.query(copy('placed'), [order.id]))
                .rejects.toThrow('orders must be created as pending_payment, got placed');
            await client.query('ROLLBACK TO SAVEPOINT s');
        });
    });
});
