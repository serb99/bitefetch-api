/**
 * Migration 2: users and auth.
 * Tables: users, courier_profiles, email_tokens, refresh_tokens, account_status_history.
 */

exports.shorthands = undefined;

const id = { type: 'bigint', primaryKey: true, sequenceGenerated: { precedence: 'BY DEFAULT' } };

exports.up = (pgm) => {
  // default now() must be a function call, not the quoted text 'now()'
  const now = () => ({ type: 'timestamptz', notNull: true, default: pgm.func('now()') });

  pgm.createTable('users', {
    id,
    email: { type: 'varchar(254)', notNull: true },
    email_verified_at: { type: 'timestamptz' },
    password_hash: { type: 'varchar(255)', notNull: true },
    role: { type: 'user_role', notNull: true },
    status: { type: 'user_status', notNull: true, default: 'pending_activation' },
    status_reason: { type: 'varchar(500)' },
    full_name: { type: 'varchar(200)', notNull: true },
    phone: { type: 'varchar(32)' },
    token_version: { type: 'int', notNull: true, default: 0 },
    version: { type: 'int', notNull: true, default: 0 },
    last_login_at: { type: 'timestamptz' },
    created_at: now(),
    updated_at: now(),
    deleted_at: { type: 'timestamptz' },
  });
  pgm.createIndex('users', [pgm.func('lower(email)')], { name: 'users_email_lower_uq', unique: true });
  pgm.createIndex('users', ['role', 'status'], { name: 'users_role_status_idx' });

  pgm.createTable('courier_profiles', {
    user_id: { type: 'bigint', primaryKey: true, references: 'users', onDelete: 'RESTRICT' },
    vehicle_type: { type: 'vehicle_type', notNull: true },
    availability: { type: 'courier_availability', notNull: true, default: 'offline' },
    offline_reason: { type: 'courier_offline_reason', default: 'manual' },
    consecutive_missed_offers: { type: 'int', notNull: true, default: 0 },
    went_online_at: { type: 'timestamptz' },
    created_at: now(),
    updated_at: now(),
  });

  pgm.createTable('email_tokens', {
    id,
    user_id: { type: 'bigint', notNull: true, references: 'users', onDelete: 'CASCADE' },
    type: { type: 'email_token_type', notNull: true },
    token_hash: { type: 'varchar(64)', notNull: true, unique: true },
    expires_at: { type: 'timestamptz', notNull: true },
    used_at: { type: 'timestamptz' },
    revoked_at: { type: 'timestamptz' },
    created_at: now(),
  });

  pgm.createTable('refresh_tokens', {
    id,
    user_id: { type: 'bigint', notNull: true, references: 'users', onDelete: 'CASCADE' },
    token_hash: { type: 'varchar(64)', notNull: true, unique: true },
    family_id: { type: 'uuid', notNull: true },
    replaced_by_id: { type: 'bigint', references: 'refresh_tokens', onDelete: 'SET NULL' },
    expires_at: { type: 'timestamptz', notNull: true },
    revoked_at: { type: 'timestamptz' },
    created_at: now(),
  });
  pgm.createIndex('refresh_tokens', 'family_id', { name: 'refresh_tokens_family_idx' });

  pgm.createTable('account_status_history', {
    id,
    user_id: { type: 'bigint', notNull: true, references: 'users', onDelete: 'CASCADE' },
    from_status: { type: 'user_status' },
    to_status: { type: 'user_status', notNull: true },
    actor: { type: 'varchar(64)', notNull: true },
    reason: { type: 'varchar(500)' },
    at: now(),
  });
  pgm.createIndex('account_status_history', ['user_id', 'at'], { name: 'account_status_history_user_idx' });
};

exports.down = (pgm) => {
  pgm.dropTable('account_status_history');
  pgm.dropTable('refresh_tokens');
  pgm.dropTable('email_tokens');
  pgm.dropTable('courier_profiles');
  pgm.dropTable('users');
};