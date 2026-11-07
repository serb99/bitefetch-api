import { z } from 'zod';

const setAvailabilitySchema = z.object({ available: z.boolean() }).strict();

export { setAvailabilitySchema };