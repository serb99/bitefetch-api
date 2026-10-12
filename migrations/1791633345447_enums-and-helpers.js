/**
 * Migration 1: enum types and the shared updated_at trigger function.
 * Everything later (tables, triggers) builds on these.
 */

exports.shorthands = undefined;

const ENUMS = {
  user_role: ['customer', 'restaurant_owner', 'courier', 'admin'],
  user_status: ['pending_activation', 'pending_approval', 'active', 'suspended', 'rejected', 'deleted'],
  application_status: ['pending', 'approved', 'rejected'],
  email_token_type: ['activation', 'password_reset'],
  vehicle_type: ['bike', 'scooter', 'car'],
  courier_availability: ['online', 'offline'],
  courier_offline_reason: ['manual', 'missed_offers', 'no_position', 'suspended'],
  brand_kind: ['chain', 'private'],
  order_status: ['pending_payment', 'placed', 'accepted', 'ready_for_pickup', 'picked_up', 'delivered', 'cancelled', 'rejected', 'expired'],
  dispatch_state: ['not_started', 'searching', 'no_courier', 'assigned'],
  payment_status: ['pending', 'authorized', 'voided', 'captured', 'capture_failed'],
  cancel_actor: ['customer', 'restaurant', 'admin', 'system'],
  offer_status: ['pending', 'accepted', 'declined', 'expired', 'withdrawn'],
  offer_decline_reason: ['too_far', 'busy', 'vehicle_unsuitable', 'other', 'went_offline'],
  cancel_request_status: ['pending', 'approved', 'rejected', 'superseded'],
  incident_type: ['no_courier', 'capture_failed', 'restaurant_unresponsive', 'kitchen_late', 'courier_problem', 'delivery_overdue'],
  courier_problem_category: ['customer_unreachable', 'wrong_or_missing_items', 'vehicle_issue', 'restaurant_closed', 'other'],
  incident_opener: ['system', 'courier', 'customer', 'restaurant', 'admin'],
  conversation_type: ['order', 'support'],
  conversation_status: ['open', 'resolved', 'closed'],
  message_kind: ['text', 'system'],
};

exports.up = (pgm) => {
    for (const [name, values] of Object.entries(ENUMS)) {
        pgm.createType(name, values);
    }

    // Reused by the BEFORE UPDATE triggers created in migration 9.
    pgm.createFunction(
      'set_updated_at',
       [],
       { returns: 'trigger', language: 'plpgsql', replace: true },
        `
        BEGIN
        NEW.updated_at = now();
        RETURN NEW;
        END;
        `
    );
};

exports.down = (pgm) =>{
    pgm.dropFunction('set_updated_at', []);
    for (const name of Object.keys(ENUMS).reverse()){
        pgm.dropType(name);
    }
}