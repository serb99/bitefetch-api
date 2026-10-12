/**
 * Migration 4: applications.
 * One row per request to become a courier or restaurant owner (a new row for every re-application).
 * Source of truth: database/schema.dbml (group "identity").
 *
 * Needs `users` (migration 2) and `restaurants` (migration 3), which is why it comes here.
 */

exports.shorthands = undefined;

exports.up = (pgm) => {
  const now = () => ({ type: 'timestamptz', notNull: true, default: pgm.func('now()') });

  pgm.createTable('applications', {
    id: { type: 'bigint', primaryKey: true, sequenceGenerated: { precedence: 'BY DEFAULT' } },
    user_id: { type: 'bigint', notNull: true, references: 'users(id)', onDelete: 'CASCADE' }, // the applicant
    role: { type: 'user_role', notNull: true }, // courier or restaurant_owner
    status: { type: 'application_status', notNull: true, default: 'pending' },
    details: { type: 'jsonb', notNull: true }, // courier: vehicle, contact; owner: restaurant details as entered
    restaurant_id: { type: 'bigint', references: 'restaurants(id)', onDelete: 'RESTRICT' }, // owners only: the OSM restaurant they picked
    attempt_no: { type: 'int', notNull: true, default: 1 }, // max 3 (enforced by a CHECK in migration 9)
    reject_reason: { type: 'varchar(500)' },
    decided_by: { type: 'bigint', references: 'users(id)', onDelete: 'SET NULL' }, // the admin who decided
    decided_at: { type: 'timestamptz' },
    version: { type: 'int', notNull: true, default: 0 }, // optimistic lock for approve / reject
    created_at: now(),
    updated_at: now(),
  });
  pgm.createIndex('applications', 'user_id', { name: 'applications_user_idx' });
  pgm.createIndex('applications', ['status', 'created_at'], { name: 'applications_queue_idx' }); // the admin queue
};

exports.down = (pgm) => {
  pgm.dropTable('applications');
};