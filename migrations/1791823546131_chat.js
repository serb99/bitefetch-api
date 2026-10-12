/**
 * Migration 8: chat.
 * Tables: conversations, messages, conversation_reads.
 * Source of truth: database/schema.dbml (group "chat").
 */

exports.shorthands = undefined;

const id = { type: 'bigint', primaryKey: true, sequenceGenerated: { precedence: 'BY DEFAULT' } };

exports.up = (pgm) => {
  const now = () => ({ type: 'timestamptz', notNull: true, default: pgm.func('now()') });

  // A chat thread: an order chat (customer and restaurant) or a support chat (customer and admin).
  pgm.createTable('conversations', {
    id,
    type: { type: 'conversation_type', notNull: true },
    order_id: { type: 'bigint', references: 'orders(id)', onDelete: 'RESTRICT' }, // required for order chats
    customer_id: { type: 'bigint', notNull: true, references: 'users(id)', onDelete: 'RESTRICT' },
    restaurant_id: { type: 'bigint', references: 'restaurants(id)', onDelete: 'RESTRICT' }, // order chats only
    status: { type: 'conversation_status', notNull: true, default: 'open' },
    last_seq: { type: 'int', notNull: true, default: 0 }, // incremented under the row lock
    last_message_at: { type: 'timestamptz' },
    last_reply_email_at: { type: 'timestamptz' }, // unread-reply email throttle: at most 1 per hour
    resolved_at: { type: 'timestamptz' },
    resolved_by: { type: 'bigint', references: 'users(id)', onDelete: 'SET NULL' },
    closed_at: { type: 'timestamptz' },
    created_at: now(),
    updated_at: now(),
  });
  pgm.createIndex('conversations', ['restaurant_id', 'last_message_at'], { name: 'conversations_restaurant_inbox_idx' });
  pgm.createIndex('conversations', ['type', 'status', 'last_message_at'], { name: 'conversations_support_inbox_idx' });
  pgm.createIndex('conversations', ['customer_id', 'last_message_at'], { name: 'conversations_customer_idx' });

  // Plain-text messages. seq is gap-free per conversation; client_msg_id makes retries idempotent.
  pgm.createTable('messages', {
    id,
    conversation_id: { type: 'bigint', notNull: true, references: 'conversations(id)', onDelete: 'RESTRICT' },
    seq: { type: 'int', notNull: true },
    sender_id: { type: 'bigint', references: 'users(id)', onDelete: 'SET NULL' }, // null for system lines
    sender_role: { type: 'user_role' },
    kind: { type: 'message_kind', notNull: true, default: 'text' },
    body: { type: 'text', notNull: true },
    client_msg_id: { type: 'uuid' }, // client-generated
    created_at: now(),
  });
  pgm.createIndex('messages', ['conversation_id', 'seq'], { name: 'messages_conversation_seq_uq', unique: true });
  pgm.createIndex('messages', ['conversation_id', 'client_msg_id'], { name: 'messages_client_msg_uq', unique: true });

  // Read position per participant. unread = conversations.last_seq - last_read_seq.
  pgm.createTable(
    'conversation_reads',
    {
      conversation_id: { type: 'bigint', notNull: true, references: 'conversations(id)', onDelete: 'CASCADE' },
      user_id: { type: 'bigint', notNull: true, references: 'users(id)', onDelete: 'CASCADE' },
      last_read_seq: { type: 'int', notNull: true, default: 0 },
      updated_at: now(),
    },
    { constraints: { primaryKey: ['conversation_id', 'user_id'] } },
  );
};

exports.down = (pgm) => {
  pgm.dropTable('conversation_reads');
  pgm.dropTable('messages');
  pgm.dropTable('conversations');
};