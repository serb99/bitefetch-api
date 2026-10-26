import { Router } from 'express';
import { validate } from '../middleware/validate';
import { customerSignupSchema } from '../schemas/authSchema';
import { activateSchema } from '../schemas/activateSchema';
import { signup, activate } from '../controllers/authController';

const router = Router(); 

router.post('/signup', validate(customerSignupSchema), signup);
router.post('/activate', validate(activateSchema), activate);

export { router as authRoutes};