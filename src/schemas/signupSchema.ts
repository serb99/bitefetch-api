import { z } from 'zod';
import { passwordRule } from './authSchema';
import { openingHoursSchema } from './restaurantSchema';

const phoneRule = z.string().trim().regex(/^\+?[0-9 ()-]{7,32}$/, 'Invalid phone number');

export const customerSignupSchema = z.object({
  email: z.string().trim().toLowerCase().email('Invalid email address').max(254),
  password: passwordRule,
  fullName: z.string().trim().min(1, 'Full name is required').max(200),
  phone: phoneRule.optional()
});

const manualRestaurantSchema = z.object({
    name: z.string().trim().min(1).max(200),
    address: z.string().trim().min(1).max(300),
    phone: phoneRule.optional(),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
});

export const ownerSignupSchema = customerSignupSchema.extend({
    osmId: z.string().trim().min(1).max(40).optional(),
    manualRestaurant: manualRestaurantSchema.optional(),
    openingHours: openingHoursSchema
})
.refine(
        (d) => (d.osmId !== undefined) !== (d.manualRestaurant !== undefined),
        { message: 'Provide either osmId or manualRestaurant' },
    );

export const courierSignupSchema = customerSignupSchema.extend({
    vehicleType: z.enum(['bike', 'scooter', 'car']),
    phone: phoneRule
});

export type CustomerSignupInput = z.infer<typeof customerSignupSchema>;
export type OwnerSignupInput = z.infer<typeof ownerSignupSchema>;
export type CourierSignupInput = z.infer<typeof courierSignupSchema>;
export type ManualRestaurantInput = z.infer<typeof manualRestaurantSchema>;