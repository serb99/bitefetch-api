import { z } from 'zod';
import { idString } from './cartSchema';

export const listOrdersQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    before: idString.optional()
});

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;