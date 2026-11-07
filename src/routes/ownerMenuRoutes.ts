import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { createMenuItemSchema, updateMenuItemSchema } from '../schemas/menuItemSchema';
import { createMenuItemHandler, listOwnerMenuHandler, setAvailabilityHandler, updateMenuItemHandler } from '../controllers/menuController';
import { validateIdParam } from '../middleware/validateIdParam';
import { setAvailabilitySchema } from '../schemas/availabilitySchema';

const router = Router();

router.post(
    '/',
    requireAuth,
    requireRole('restaurant_owner'),
    validate(createMenuItemSchema),
    createMenuItemHandler
);

router.patch(
    '/:id',
    requireAuth,
    requireRole('restaurant_owner'),
    validateIdParam,
    validate(updateMenuItemSchema),
    updateMenuItemHandler
);

router.get('/', requireAuth, requireRole('restaurant_owner'), listOwnerMenuHandler);
router.put(
    '/:id/availability',
    requireAuth,
    requireRole('restaurant_owner'),
    validateIdParam,
    validate(setAvailabilitySchema),
    setAvailabilityHandler
);

export { router as ownerMenuRoutes };