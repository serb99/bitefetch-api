import { z } from 'zod';

export const loginSchema = z.object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(1).refine(
    (value) => Buffer.byteLength(value, 'utf8') <= 72,
    'Invalid credentials',)
});

export type LoginInput = z.infer<typeof loginSchema>;