import type { Request, Response } from 'express';
import { AppError } from '../errors/AppError';
import { searchQuerySchema } from '../schemas/osmSchema';
import { searchPlaces } from '../services/osmSearchService';
import type { SearchKind } from '../services/osmClient';

// builds a handler for one kind of search
function searchHandlerFor(kind: SearchKind) {
    return async (req: Request, res: Response): Promise<void> => {
        const parsed = searchQuerySchema.safeParse(req.query);
        if (!parsed.success) {
            throw new AppError(
                400,
                'VALIDATION_ERROR',
                'Invalid query parameters',
                parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
            );
        }

        res.json(await searchPlaces(kind, parsed.data.q));
    };
}

const searchRestaurantsHandler = searchHandlerFor('restaurant');
const searchAddressesHandler = searchHandlerFor('address');

export { searchRestaurantsHandler, searchAddressesHandler };