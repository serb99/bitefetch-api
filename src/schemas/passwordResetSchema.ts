import { z } from 'zod';
import { passwordRule } from './authSchema';

export const requestResetSchema = z.object({
    email: z.string().trim().toLowerCase().email().max(254),
});

export const confirmResetSchema = z.object({
    token: z.string().min(1).max(200),
    newPassword: passwordRule,
});

export type RequestResetInput = z.infer<typeof requestResetSchema>;
export type ConfirmResetInput = z.infer<typeof confirmResetSchema>;