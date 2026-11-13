import { z } from 'zod';

const addressShape = z.object({
    label: z.string().trim().min(1).max(50).nullable().optional(),
    street: z.string().trim().min(1).max(300),
    details: z.string().trim().min(1).max(300).nullable().optional(),
    city: z.string().trim().min(1).max(100),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
});

export const createAddressSchema = addressShape.strict();

export const updateAddressSchema = addressShape
    .partial()
    .strict()
    .refine((data) => Object.keys(data).length > 0, 'Send at least one field');

export type CreateAddressInput = z.infer<typeof createAddressSchema>;
export type UpdateAddressInput = z.infer<typeof updateAddressSchema>;