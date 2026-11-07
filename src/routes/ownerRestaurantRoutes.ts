import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { updateRestaurantSchema } from '../schemas/restaurantSchema';
import { getOwnerRestaurantHandler, updateOwnerRestaurantHandler } from '../controllers/restaurantController';

const router = Router();

router.get('/', requireAuth, requireRole('restaurant_owner'), getOwnerRestaurantHandler);
router.patch(
    '/',
    requireAuth,
    requireRole('restaurant_owner'),
    validate(updateRestaurantSchema),
    updateOwnerRestaurantHandler
);

export { router as ownerRestaurantRoutes };