import { z } from 'zod';

export const acceptOrderSchema = z
    .object({
        prepMinutes: z.number().int().min(10).max(60).multipleOf(5).optional()
    })
    .default({});

const note = z.string().trim().max(500).optional();

function otherNeedsNote(body: { reasonCode: string; note?: string }): boolean {
    return body.reasonCode !== 'other' || Boolean(body.note);
}

const noteRule = { message: 'A note is required when the reason is other', path: ['note'] };

export const rejectOrderSchema = z
    .object({
        reasonCode: z.enum(['out_of_stock', 'too_busy', 'closing_soon', 'other']),
        note
    })
    .refine(otherNeedsNote, noteRule);

export const ownerCancelOrderSchema = z
    .object({
        reasonCode: z.enum(['out_of_stock', 'kitchen_issue', 'too_busy', 'other']),
        note
    })
    .refine(otherNeedsNote, noteRule);

export type AcceptOrderBody = z.infer<typeof acceptOrderSchema>;
export type RejectOrderBody = z.infer<typeof rejectOrderSchema>;
export type OwnerCancelOrderBody = z.infer<typeof ownerCancelOrderSchema>;