import { Router } from 'express';
import { validate } from '../middleware/validate';
import { customerSignupSchema, ownerSignupSchema, courierSignupSchema } from '../schemas/signupSchema';
import { activateSchema } from '../schemas/activateAccountSchema';
import { signupCustomerHandler, signupOwnerHandler, signupCourierHandler, activateHandler } from '../controllers/accountController';
import { signupLimiter } from '../middleware/rateLimits';

const router = Router(); 

router.post('/customers', signupLimiter, validate(customerSignupSchema), signupCustomerHandler);
router.post('/restaurant-owners', validate(ownerSignupSchema), signupOwnerHandler);
router.post('/couriers', validate(courierSignupSchema), signupCourierHandler);
router.post('/account-activations', validate(activateSchema), activateHandler);

export { router as accountRoutes};