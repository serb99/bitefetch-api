import type { Request, Response } from 'express';
import { AppError } from '../errors/AppError';
import { nearbyQuerySchema } from '../schemas/browseSchema';
import { listNearbyRestaurants, getRestaurantMenu } from '../services/browseService';

async function listNearbyHandler(req: Request, res: Response): Promise<void> {
    const parsed = nearbyQuerySchema.safeParse(req.query);
    if (!parsed.success) {
        throw new AppError(
            400,
            'VALIDATION_ERROR',
            'Invalid query parameters',
            parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        );
    }

    const { lat, lng, radiusKm } = parsed.data;
    res.json(await listNearbyRestaurants(lat, lng, radiusKm));
}

async function getMenuHandler(req: Request<{ id: string }>, res: Response): Promise<void> {
    res.json(await getRestaurantMenu(req.params.id));
}

export { listNearbyHandler, getMenuHandler };