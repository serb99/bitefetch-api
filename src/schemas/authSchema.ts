import { z } from 'zod';

export const passwordRule = z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, {
        message: 'Password must be at most 72 bytes',
    });