import { z } from 'zod';

export const checkoutBodySchema = z
        .object({
            expectedTotalMinor: z.number().int().min(0),
        })
    .strict();

// the Idempotency-Key header
export const idempotencyKeySchema = z.string().trim().min(1).max(100);

export type CheckoutBody = z.infer<typeof checkoutBodySchema>;