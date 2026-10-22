import { z } from 'zod';

export const customerSignupSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address').max(254),

  // Not trimmed on purpose: spaces can be part of a password.
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .refine(
      (value) => Buffer.byteLength(value, 'utf8') <= 72,
      'Password is too long (max 72 bytes)',
    ),

  fullName: z.string().trim().min(1, 'Full name is required').max(200),

  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,32}$/, 'Invalid phone number')
    .optional(),
});

export type CustomerSignupInput = z.infer<typeof customerSignupSchema>;