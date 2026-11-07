import type { Request, Response } from 'express';
import { getOwnerRestaurant, updateOwnerRestaurant } from '../services/restaurantService';

async function getOwnerRestaurantHandler(req: Request, res: Response): Promise<void> {
    res.json(await getOwnerRestaurant(req.user!.id));
}

async function updateOwnerRestaurantHandler(req: Request, res: Response): Promise<void> {
    res.json(await updateOwnerRestaurant(req.user!.id, req.body));
}
    
export { getOwnerRestaurantHandler, updateOwnerRestaurantHandler };