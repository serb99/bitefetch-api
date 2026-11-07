import { z } from 'zod';

// the fields an owner can set, written once and reused by create and update

const menuItemShape = {
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).optional(),
    priceMinor: z.number().int().min(0).max(100_000),
    category: z.string().trim().min(1).max(100).optional(),
    sortOrder: z.number().int().min(0).max(10_000).optional(),
    imageUrl: z
        .string()
        .max(1000)
        .url()
        .refine((u) => u.startsWith('https://'), 'must be an https URL')
        .optional(),
};

const createMenuItemSchema = z.object(menuItemShape).strict();

// PATCH: every field optional, plus isActive (the soft delete / restore switch)
const updateMenuItemSchema = z
    .object({ ...menuItemShape, isActive: z.boolean() })
    .partial()
    .strict()
    .refine((body) => Object.keys(body).length > 0, 'at least one field is required');

type CreateMenuItemInput = z.infer<typeof createMenuItemSchema>;
type UpdateMenuItemInput = z.infer<typeof updateMenuItemSchema>;

export { createMenuItemSchema, updateMenuItemSchema };
export type { CreateMenuItemInput, UpdateMenuItemInput };