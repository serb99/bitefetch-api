import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { validateIdParam } from '../middleware/validateIdParam';
import { acceptOrderSchema, rejectOrderSchema, ownerCancelOrderSchema, cancelRequestSchema } from '../schemas/ownerOrderSchema';
import {
    listActiveOrdersHandler,
    acceptOrderHandler,
    rejectOrderHandler,
    markReadyHandler,
    ownerCancelOrderHandler,
    requestCancellationHandler
} from '../controllers/ownerOrderController';

const router = Router();

router.use(requireAuth, requireRole('restaurant_owner'));

router.get('/', listActiveOrdersHandler);
router.post('/:id/accept', validateIdParam, validate(acceptOrderSchema), acceptOrderHandler);
router.post('/:id/reject', validateIdParam, validate(rejectOrderSchema), rejectOrderHandler);
router.post('/:id/ready', validateIdParam, markReadyHandler);
router.post('/:id/cancel', validateIdParam, validate(ownerCancelOrderSchema), ownerCancelOrderHandler);
router.post('/:id/cancel-request', validateIdParam, validate(cancelRequestSchema), requestCancellationHandler);

export { router as ownerOrderRoutes };
