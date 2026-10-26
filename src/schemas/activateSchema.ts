import { z } from 'zod';

export const activateSchema = z.object({
    token: z.string().trim().min(1).max(200)
});

export type ActivateInput = z.infer<typeof activateSchema>;