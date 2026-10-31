import { Router } from 'express';
import { validate } from '../middleware/validate';
import { requestResetHandler, confirmResetHandler } from '../controllers/passwordResetController';
import { requestResetSchema,  confirmResetSchema } from '../schemas/passwordResetSchema';
import { passwordResetLimiter } from '../middleware/rateLimits';

const router = Router(); 
const confirmationRouter = Router();

router.post('/', passwordResetLimiter, validate(requestResetSchema), requestResetHandler);
confirmationRouter.post('/', validate(confirmResetSchema), confirmResetHandler);

export { router as passwordResetRoutes, confirmationRouter as passwordResetConfirmationRoutes };