import { Router } from 'express';
import { validate } from '../middleware/validate';
import { loginSchema } from '../schemas/loginSchema';
import { loginHandler, refreshHandler, logoutHandler } from '../controllers/authController';
import { loginLimiter } from '../middleware/rateLimits';

const router = Router();

router.post('/', loginLimiter, validate(loginSchema), loginHandler);
router.post('/refresh', refreshHandler);
router.delete('/current', logoutHandler);

export { router as sessionRoutes };