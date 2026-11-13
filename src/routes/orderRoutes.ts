import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { createOrderHandler, listOrdersHandler, getOrderHandler } from '../controllers/orderController';
import { validate } from '../middleware/validate';
import { checkoutBodySchema } from '../schemas/checkoutSchema';
import { validateIdParam } from '../middleware/validateIdParam';

const router = Router();

router.use(requireAuth, requireRole('customer'));

router.post('/', validate(checkoutBodySchema), createOrderHandler);
router.get('/', listOrdersHandler);
router.get('/:id', validateIdParam, getOrderHandler);

export { router as orderRoutes};