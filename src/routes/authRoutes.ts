import { Router } from 'express';
import { validate } from '../middleware/validate';
import { customerSignupSchema, ownerSignupSchema, courierSignupSchema } from '../schemas/authSchema';
import { activateSchema } from '../schemas/activateSchema';
import { signupCustomerHandler, signupOwnerHandler, signupCourierHandler, activateHandler } from '../controllers/authController';

const router = Router(); 

router.post('/signup', validate(customerSignupSchema), signupCustomerHandler);
router.post('/signup/owner', validate(ownerSignupSchema), signupOwnerHandler);
router.post('/signup/courier', validate(courierSignupSchema), signupCourierHandler);
router.post('/activate', validate(activateSchema), activateHandler);

export { router as authRoutes};