import type { PoolClient } from 'pg';

// Same values as the incident_type enum. restaurant_unresponsive has no order (see acceptTimeout.ts).
type OrderIncidentType = 'no_courier' | 'capture_failed' | 'kitchen_late' | 'courier_problem' | 'delivery_overdue';
type ProblemCategory = 'customer_unreachable' | 'wrong_or_missing_items' | 'vehicle_issue' | 'restaurant_closed' | 'other';
type IncidentOpener = 'system' | 'courier' | 'customer' | 'restaurant' | 'admin';

type NewIncident = {
    orderId: string;
    type: OrderIncidentType;
    openedBy: IncidentOpener;
    openedByUserId?: string | null;
    category?: ProblemCategory | null;
    details?: string | null;
};

// Opens an incident on an order. One open incident per order and type (order_incidents_one_open_uq):
// a second one while the first is open is skipped. Returns the new id, or null when one was already open.
async function openOrderIncident(client: PoolClient, incident: NewIncident): Promise<string | null> {
    const { rows } = await client.query<{ id: string }>(
        `INSERT INTO order_incidents (order_id, restaurant_id, type, category, opened_by, opened_by_user_id, details)
         SELECT o.id, o.restaurant_id, $2, $3, $4, $5, $6
           FROM orders o
          WHERE o.id = $1
         ON CONFLICT (order_id, type) WHERE resolved_at IS NULL AND order_id IS NOT NULL DO NOTHING
         RETURNING id`,
        [
            incident.orderId,
            incident.type,
            incident.category ?? null,
            incident.openedBy,
            incident.openedByUserId ?? null,
            incident.details ?? null
        ]
    );
    return rows[0]?.id ?? null;
}

// Closes the order's open incidents of these types ('all' = every type). resolvedBy is the admin, null for the system.
// Incidents resolve themselves when the order moves past the problem.
async function resolveOrderIncidents(
    client: PoolClient,
    orderId: string,
    types: readonly OrderIncidentType[] | 'all',
    note: string,
    resolvedBy: string | null = null
): Promise<number> {
    const result = await client.query(
        `UPDATE order_incidents
            SET resolved_at = now(),
                resolved_by = $3,
                resolution_note = $4
          WHERE order_id = $1
            AND resolved_at IS NULL
            AND ($2::incident_type[] IS NULL OR type = ANY($2::incident_type[]))`,
        [orderId, types === 'all' ? null : types, resolvedBy, note.slice(0, 500)]
    );
    return result.rowCount ?? 0;
}

export { openOrderIncident, resolveOrderIncidents };
export type { OrderIncidentType, ProblemCategory, IncidentOpener, NewIncident };
