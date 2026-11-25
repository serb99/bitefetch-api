import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { requireLiveSession } from '../middleware/requireLiveSession';
import { validate } from '../middleware/validate';
import { validateIdParam } from '../middleware/validateIdParam';
import { adminReasonSchema, adminVersionSchema } from '../schemas/adminSchema';
import {
    getAdminOrderHandler,
    adminCancelOrderHandler,
    adminMarkPickedUpHandler,
    adminMarkDeliveredHandler,
    retryDispatchHandler,
    reassignCourierHandler,
    approveCancelRequestHandler,
    rejectCancelRequestHandler
} from '../controllers/adminOrderController';

const router = Router();

// The access token lives 15 min: an admin who was suspended or logged out must stop at once,
// so every admin request re-checks the account and the session in the database.
router.use(requireAuth, requireRole('admin'), requireLiveSession);

router.get('/orders/:id', validateIdParam, getAdminOrderHandler);
router.post('/orders/:id/cancel', validateIdParam, validate(adminReasonSchema), adminCancelOrderHandler);
router.post('/orders/:id/mark-picked-up', validateIdParam, validate(adminReasonSchema), adminMarkPickedUpHandler);
router.post('/orders/:id/mark-delivered', validateIdParam, validate(adminReasonSchema), adminMarkDeliveredHandler);
router.post('/orders/:id/retry-dispatch', validateIdParam, validate(adminVersionSchema), retryDispatchHandler);
router.post('/orders/:id/reassign-courier', validateIdParam, validate(adminReasonSchema), reassignCourierHandler);

router.post('/cancel-requests/:id/approve', validateIdParam, validate(adminVersionSchema), approveCancelRequestHandler);
router.post('/cancel-requests/:id/reject', validateIdParam, validate(adminVersionSchema), rejectCancelRequestHandler);

export { router as adminRoutes };
