import { z } from 'zod';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use HH:MM');

const range = z
    .tuple([time, time])
    .refine(([open, close]) => open < close, 'open must be before close');

function inOrderWithoutOverlap(ranges: [string, string][]): boolean {
    for (let i = 1; i < ranges.length; i++) {
        if (ranges[i][0] < ranges[i - 1][1]) return false;
    }
    return true;
}

const day = z
    .array(range)
    .max(3)
    .refine(inOrderWithoutOverlap, 'ranges must be in order and not overlap');

export const openingHoursSchema = z
    .object({
        mon: day.optional(),
        tue: day.optional(),
        wed: day.optional(),
        thu: day.optional(),
        fri: day.optional(),
        sat: day.optional(),
        sun: day.optional(),
    })
    .strict();    

const updateRestaurantSchema = z
    .object({
        name: z.string().trim().min(1).max(200),
        address: z.string().trim().min(1).max(300),
        phone: z.string().trim().regex(/^\+?[0-9 ()-]{6,32}$/, 'invalid phone number'),
        openingHours: openingHoursSchema,
        isOpen: z.boolean(),
        pausedUntil: z
            .string()
            .datetime({ offset: true })
            .refine((v) => new Date(v) > new Date(), 'must be in the future')
            .nullable(),
    })
    .partial()
    .strict()
    .refine((body) => Object.keys(body).length > 0, 'at least one field is required');

type UpdateRestaurantInput = z.infer<typeof updateRestaurantSchema>;

export { updateRestaurantSchema };
export type { UpdateRestaurantInput };