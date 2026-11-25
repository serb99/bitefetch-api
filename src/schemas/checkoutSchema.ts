import { z } from 'zod';

export const checkoutBodySchema = z
        .object({
            expectedTotalMinor: z.number().int().min(0),
            // M9b: who delivers. Optional so every caller from before M9b keeps getting a human courier.
            deliveryMode: z.enum(['human', 'robot']).default('human'),
        })
    .strict();

// the Idempotency-Key header
export const idempotencyKeySchema = z.string().trim().min(1).max(100);

export type CheckoutBody = z.infer<typeof checkoutBodySchema>;
export type DeliveryMode = CheckoutBody['deliveryMode'];
