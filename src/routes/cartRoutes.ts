import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import {
    getCartHandler,
    setCartItemHandler,
    removeCartItemHandler,
    clearCartHandler,
    setCartAddressHandler
} from '../controllers/cartController';
import { validateIdParam } from '../middleware/validateIdParam';
import { validate } from '../middleware/validate';
import { setCartItemSchema, setCartAddressSchema } from '../schemas/cartSchema';

const router = Router();

router.use(requireAuth, requireRole('customer'));

router.get('/', getCartHandler);
router.delete('/', clearCartHandler);
router.put('/items/:id', validateIdParam, validate(setCartItemSchema), setCartItemHandler);
router.delete('/items/:id', validateIdParam, removeCartItemHandler);
router.put('/address', validate(setCartAddressSchema), setCartAddressHandler);

export { router as cartRoutes };