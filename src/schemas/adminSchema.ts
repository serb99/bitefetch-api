import { z } from 'zod';

// The order (or request) version the admin saw on their page: optimistic check, 409 VERSION_CONFLICT if it moved.
const version = z.number().int().min(0);

// cancel, mark picked up / delivered, reassign: a reason is required (it goes to the audit trail).
export const adminReasonSchema = z
    .object({
        reason: z.string().trim().min(3).max(500),
        version
    })
    .strict();

// retry dispatch and the cancel request decision: only the version.
export const adminVersionSchema = z.object({ version }).strict();

export type AdminReasonBody = z.infer<typeof adminReasonSchema>;
export type AdminVersionBody = z.infer<typeof adminVersionSchema>;
