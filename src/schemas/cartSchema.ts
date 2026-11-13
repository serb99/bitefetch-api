import { z } from 'zod';

export const idString = z.string().regex(/^\d{1,18}$/, 'Invalid id');

export const setCartItemSchema = z
    .object({
        restaurantId: idString,
        quantity: z.number().int().min(1).max(50),
    })
    .strict();

export const setCartAddressSchema = z
    .object({
        addressId: idString,
    })
    .strict();

export type SetCartItemInput = z.infer<typeof setCartItemSchema>;
export type SetCartAddressInput = z.infer<typeof setCartAddressSchema>;