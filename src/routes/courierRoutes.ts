import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { courierPositionSchema, courierAvailabilitySchema, declineOfferSchema, reportProblemSchema } from '../schemas/courierSchema';
import {
    getCourierStateHandler,
    updatePositionHandler,
    setAvailabilityHandler,
} from '../controllers/courierController';
import {
    getCurrentOfferHandler,
    acceptOfferHandler,
    declineOfferHandler
} from '../controllers/courierOfferController';
import {
    getCurrentOrderHandler,
    pickUpOrderHandler,
    deliverOrderHandler,
    reportProblemHandler
} from '../controllers/courierOrderController';
import { validateIdParam } from '../middleware/validateIdParam';

const router = Router();

router.use(requireAuth, requireRole('courier'));

router.get('/', getCourierStateHandler);
router.put('/position', validate(courierPositionSchema), updatePositionHandler);
router.post('/availability', validate(courierAvailabilitySchema), setAvailabilityHandler);
router.get('/offers/current', getCurrentOfferHandler);

router.post('/offers/:id/accept', validateIdParam, acceptOfferHandler);
router.post('/offers/:id/decline', validateIdParam, validate(declineOfferSchema), declineOfferHandler);

router.get('/orders/current', getCurrentOrderHandler);
router.post('/orders/:id/pickup', validateIdParam, pickUpOrderHandler);
router.post('/orders/:id/deliver', validateIdParam, deliverOrderHandler);
router.post('/orders/:id/problems', validateIdParam, validate(reportProblemSchema), reportProblemHandler);

export { router as courierRoutes };