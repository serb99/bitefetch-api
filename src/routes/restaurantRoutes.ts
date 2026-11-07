import { Router } from 'express';
import { listNearbyHandler, getMenuHandler } from '../controllers/browseController';
import { validateIdParam } from '../middleware/validateIdParam';

const router = Router();

router.get('/', listNearbyHandler);
router.get('/:id/menu', validateIdParam, getMenuHandler);

export { router as restaurantRoutes };