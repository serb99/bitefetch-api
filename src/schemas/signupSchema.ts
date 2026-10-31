import { z } from 'zod';
import { passwordRule } from './authSchema';

const phoneRule = z.string().trim().regex(/^\+?[0-9 ()-]{7,32}$/, 'Invalid phone number');

export const customerSignupSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address').max(254),
  password: passwordRule,
  fullName: z.string().trim().min(1, 'Full name is required').max(200),
  phone: phoneRule.optional()
});

export const ownerSignupSchema = customerSignupSchema.extend({
    restaurantName: z.string().trim().min(1).max(200),
    restaurantAddress: z.string().trim().min(1).max(300),
    restaurantId: z.string().regex(/^\d+$/, 'Invalid restaurant id').optional()
});

export const courierSignupSchema = customerSignupSchema.extend({
    vehicleType: z.enum(['bike', 'scooter', 'car']),
    phone: phoneRule
});

export type CustomerSignupInput = z.infer<typeof customerSignupSchema>;
export type OwnerSignupInput = z.infer<typeof ownerSignupSchema>;
export type CourierSignupInput = z.infer<typeof courierSignupSchema>;