import { z } from 'zod';

export const courierPositionSchema = z
    .object({
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        // The GPS gives decimals (12.6 m), the columns are int
        accuracyM: z.number().min(0).max(1_000_000).transform(Math.round).nullable().optional(),
        headingDeg: z.number().min(0).max(360).transform((deg) => Math.round(deg) % 360).nullable().optional(),
        speedMps: z.number().min(0).max(100).nullable().optional(),
        // The device clock: stored for information only.
        recordedAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value))
    })
    .strict();

export const courierAvailabilitySchema = z.object({ online: z.boolean() }).strict();

export const declineOfferSchema = z
    .object({
        reason: z.enum(['too_far', 'busy', 'vehicle_unsuitable', 'other']).optional()
    })
    .strict()
    .default({});

// The courier's "Report a problem" (a note is required for other)
export const reportProblemSchema = z
    .object({
        category: z.enum(['customer_unreachable', 'wrong_or_missing_items', 'vehicle_issue', 'restaurant_closed', 'other']),
        note: z.string().trim().min(1).max(1000).optional()
    })
    .strict()
    .refine((body) => body.category !== 'other' || Boolean(body.note), {
        message: 'A note is required when the category is other',
        path: ['note']
    });

export type ReportProblemBody = z.infer<typeof reportProblemSchema>;
export type CourierPositionBody = z.infer<typeof courierPositionSchema>;
export type CourierAvailabilityBody = z.infer<typeof courierAvailabilitySchema>;
export type DeclineOfferBody = z.infer<typeof declineOfferSchema>;