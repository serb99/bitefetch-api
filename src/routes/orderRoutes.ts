import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { 
    createOrderHandler, 
    listOrdersHandler, 
    getOrderHandler, 
    getOrderPaymentHandler,
    cancelOrderHandler,
    getOrderTrackingHandler,
    getOrderRouteHandler
} from '../controllers/orderController';
import { validate } from '../middleware/validate';
import { checkoutBodySchema } from '../schemas/checkoutSchema';
import { cancelOrderSchema } from '../schemas/orderSchema';
import { validateIdParam } from '../middleware/validateIdParam';

const router = Router();

router.use(requireAuth, requireRole('customer'));

router.post('/', validate(checkoutBodySchema), createOrderHandler);
router.get('/', listOrdersHandler);
router.get('/:id', validateIdParam, getOrderHandler);
router.get('/:id/payment', validateIdParam, getOrderPaymentHandler);
router.post('/:id/cancel', validateIdParam, validate(cancelOrderSchema), cancelOrderHandler);

router.get('/:id/tracking', validateIdParam, getOrderTrackingHandler);
router.get('/:id/route', validateIdParam, getOrderRouteHandler);

export { router as orderRoutes};