import { Router } from 'express';
import { osmSearchLimiter } from '../middleware/rateLimits';
import { searchRestaurantsHandler, searchAddressesHandler } from '../controllers/osmController';

const router = Router();

router.get('/restaurants', osmSearchLimiter, searchRestaurantsHandler);
router.get('/addresses', osmSearchLimiter, searchAddressesHandler);

export { router as osmRoutes };