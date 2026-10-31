import { pool } from '../../helpers/db';
import { createUser } from '../../helpers/users';
import { withTransaction } from '../../../src/database/transaction';
import { generateToken, hashToken } from '../../../src/utils/tokens';

// The account rules that live in the database (constraints, partial unique indexes, triggers;
// migrations 9-11). They hold even for code that bypasses the services.

async function insertUser(fields: { email?: string; role?: string; status?: string; deleted?: boolean; tokenVersion?: number } = {}) {
    return pool.query(
        `INSERT INTO users (email, password_hash, role, status, full_name, deleted_at, token_version)
         VALUES ($1, 'x', $2, $3, 'Rule Test', CASE WHEN $4::boolean THEN now() END, $5) RETURNING id`,
        [fields.email ?? 'rule@example.com', fields.role ?? 'customer', fields.status ?? 'active',
            fields.deleted ?? false, fields.tokenVersion ?? 0]);
}

async function insertApplication(userId: string, fields: Record<string, unknown> = {}) {
    const f = { role: 'courier', status: 'pending', attempt_no: 1, decided_at: null, reject_reason: null, restaurant_id: null, ...fields };
    return pool.query(
        `INSERT INTO applications (user_id, role, status, details, attempt_no, decided_at, reject_reason, restaurant_id)
         VALUES ($1, $2, $3, '{}', $4, $5, $6, $7)`,
        [userId, f.role, f.status, f.attempt_no, f.decided_at, f.reject_reason, f.restaurant_id]);
}

const violation = (code: string, constraint?: string) =>
    expect.objectContaining(constraint ? { code, constraint } : { code });

describe('users', () => {
    it('keeps emails unique regardless of case (users_email_lower_uq)', async () => {
        await insertUser({ email: 'ana@example.com' });

        await expect(insertUser({ email: 'ANA@Example.com' })).rejects.toEqual(violation('23505', 'users_email_lower_uq'));
    });

    it('allows pending_approval only for couriers and owners (users_approval_roles)', async () => {
        await expect(insertUser({ role: 'customer', status: 'pending_approval' }))
            .rejects.toEqual(violation('23514', 'users_approval_roles'));
        await expect(insertUser({ role: 'courier', status: 'pending_approval' })).resolves.toBeDefined();
    });

    it('requires deleted_at exactly when the status is deleted (users_deleted_consistent)', async () => {
        await expect(insertUser({ status: 'deleted', deleted: false })).rejects.toEqual(violation('23514', 'users_deleted_consistent'));
        await expect(insertUser({ status: 'active', deleted: true })).rejects.toEqual(violation('23514', 'users_deleted_consistent'));
    });

    it('rejects a negative token_version (users_counters_non_negative)', async () => {
        await expect(insertUser({ tokenVersion: -1 })).rejects.toEqual(violation('23514', 'users_counters_non_negative'));
    });

    it('rejects an unknown role or status (enum types)', async () => {
        await expect(insertUser({ role: 'superuser' })).rejects.toEqual(violation('22P02'));
        await expect(insertUser({ status: 'banned' })).rejects.toEqual(violation('22P02'));
    });

    it('maintains updated_at on every update', async () => {
        const user = await createUser();
        const before = (await pool.query(`SELECT updated_at FROM users WHERE id = $1`, [user.id])).rows[0].updated_at;

        await pool.query(`UPDATE users SET full_name = 'Renamed' WHERE id = $1`, [user.id]);

        const after = (await pool.query(`SELECT updated_at FROM users WHERE id = $1`, [user.id])).rows[0].updated_at;
        expect(after.getTime()).toBeGreaterThan(before.getTime());
    });

    it('deletes tokens, applications and history together with the user (ON DELETE CASCADE)', async () => {
        const user = await createUser({ role: 'courier', status: 'pending_approval' });
        await insertApplication(user.id);
        await pool.query(
            `INSERT INTO email_tokens (user_id, type, token_hash, expires_at) VALUES ($1, 'activation', $2, now() + interval '1 hour')`,
            [user.id, hashToken(generateToken())]);
        await pool.query(
            `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at) VALUES ($1, $2, gen_random_uuid(), now() + interval '1 day')`,
            [user.id, hashToken(generateToken())]);

        await pool.query(`DELETE FROM users WHERE id = $1`, [user.id]);

        const { rows } = await pool.query(
            `SELECT (SELECT count(*) FROM applications WHERE user_id = $1)::int AS apps,
                    (SELECT count(*) FROM email_tokens WHERE user_id = $1)::int AS email_tokens,
                    (SELECT count(*) FROM refresh_tokens WHERE user_id = $1)::int AS refresh_tokens,
                    (SELECT count(*) FROM account_status_history WHERE user_id = $1)::int AS history`, [user.id]);
        expect(rows[0]).toEqual({ apps: 0, email_tokens: 0, refresh_tokens: 0, history: 0 });
    });
});

describe('account_status_history trigger', () => {
    async function history(userId: string) {
        const { rows } = await pool.query(
            `SELECT from_status, to_status, actor, reason FROM account_status_history WHERE user_id = $1 ORDER BY id`, [userId]);
        return rows;
    }

    it('records the actor and reason set with SET LOCAL in the transaction', async () => {
        const user = await createUser({ status: 'active' });

        await withTransaction(async (client) => {
            await client.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [user.id]);
        }, 'user:7', 'too many chargebacks');

        expect(await history(user.id)).toEqual([
            { from_status: null, to_status: 'active', actor: 'test:fixture', reason: 'test user' },
            { from_status: 'active', to_status: 'suspended', actor: 'user:7', reason: 'too many chargebacks' },
        ]);
    });

    it("falls back to 'system:unknown' when no actor was set", async () => {
        const user = await createUser({ status: 'active' });

        await pool.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [user.id]);

        expect((await history(user.id))[1]).toEqual(
            { from_status: 'active', to_status: 'suspended', actor: 'system:unknown', reason: null });
    });

    it('does not record an update that keeps the same status', async () => {
        const user = await createUser({ status: 'active' });

        await pool.query(`UPDATE users SET status = 'active', full_name = 'Same Status' WHERE id = $1`, [user.id]);

        expect(await history(user.id)).toHaveLength(1);
    });

    it('does not leak the actor of one transaction into the next one on the same connection', async () => {
        const user = await createUser({ status: 'active' });
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(`SELECT set_config('app.actor', 'user:1', true)`);
            await client.query('COMMIT');
            await client.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [user.id]);
        } finally {
            client.release();
        }

        expect((await history(user.id))[1].actor).toBe('system:unknown');
    });
});

describe('applications', () => {
    let applicantId: string;

    beforeEach(async () => {
        applicantId = (await createUser({ role: 'courier', status: 'pending_approval' })).id;
    });

    it('allows only one pending application per user (applications_one_pending_uq)', async () => {
        await insertApplication(applicantId);

        await expect(insertApplication(applicantId, { attempt_no: 2 })).rejects.toEqual(violation('23505', 'applications_one_pending_uq'));
    });

    it('allows a new pending application after the previous one was decided', async () => {
        await insertApplication(applicantId, { status: 'rejected', decided_at: new Date(), reject_reason: 'blurry ID' });

        await expect(insertApplication(applicantId, { attempt_no: 2 })).resolves.toBeDefined();
    });

    it('accepts only courier and restaurant_owner applications (applications_role)', async () => {
        await expect(insertApplication(applicantId, { role: 'customer' })).rejects.toEqual(violation('23514', 'applications_role'));
        await expect(insertApplication(applicantId, { role: 'admin' })).rejects.toEqual(violation('23514', 'applications_role'));
    });

    it.each([0, 4])('limits attempt_no to 1..3 (attempt_no = %i)', async (attempt) => {
        await expect(insertApplication(applicantId, { attempt_no: attempt })).rejects.toEqual(violation('23514', 'applications_attempts'));
    });

    it('requires decided_at exactly when the application is decided (applications_decided_consistent)', async () => {
        await expect(insertApplication(applicantId, { status: 'approved' }))
            .rejects.toEqual(violation('23514', 'applications_decided_consistent'));
        await expect(insertApplication(applicantId, { status: 'pending', decided_at: new Date() }))
            .rejects.toEqual(violation('23514', 'applications_decided_consistent'));
    });

    it('requires a reason to reject (applications_reject_reason)', async () => {
        await expect(insertApplication(applicantId, { status: 'rejected', decided_at: new Date() }))
            .rejects.toEqual(violation('23514', 'applications_reject_reason'));
    });

    it('lets only owner applications point at a restaurant (applications_restaurant_owner_only)', async () => {
        await expect(insertApplication(applicantId, { role: 'courier', restaurant_id: 1 }))
            .rejects.toEqual(violation('23514', 'applications_restaurant_owner_only'));
    });

    it('requires the picked restaurant to exist (foreign key)', async () => {
        const owner = await createUser({ role: 'restaurant_owner', status: 'pending_approval' });

        await expect(insertApplication(owner.id, { role: 'restaurant_owner', restaurant_id: 999999 }))
            .rejects.toEqual(violation('23503', 'applications_restaurant_id_fkey'));
    });
});

describe('email_tokens', () => {
    it('stores each token hash only once', async () => {
        const user = await createUser();
        const hash = hashToken(generateToken());
        const insert = () => pool.query(
            `INSERT INTO email_tokens (user_id, type, token_hash, expires_at) VALUES ($1, 'activation', $2, now() + interval '1 hour')`,
            [user.id, hash]);
        await insert();

        await expect(insert()).rejects.toEqual(violation('23505'));
    });

    it('requires the expiry to be after the creation (email_tokens_expiry_after_creation)', async () => {
        const user = await createUser();

        await expect(pool.query(
            `INSERT INTO email_tokens (user_id, type, token_hash, expires_at) VALUES ($1, 'activation', $2, now() - interval '1 minute')`,
            [user.id, hashToken(generateToken())]))
            .rejects.toEqual(violation('23514', 'email_tokens_expiry_after_creation'));
    });
});
