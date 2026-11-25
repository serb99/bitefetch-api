import { z } from 'zod';
import { idString } from './cartSchema';

export const listOrdersQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    before: idString.optional()
});

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

// POST /orders/:id/cancel: the body is optional (the confirm dialog has an optional reason).
export const cancelOrderSchema = z
    .object({
        note: z.string().trim().max(500).optional()
    })
    .default({});

export type CancelOrderBody = z.infer<typeof cancelOrderSchema>;
