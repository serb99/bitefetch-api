import { z } from 'zod';

const searchQuerySchema = z.object({
    q: z.string().trim().min(3).max(100),
});

export { searchQuerySchema };