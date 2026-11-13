import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth'; 
import { getMeHandler } from '../controllers/userController';

const router = Router();

router.get('/', requireAuth, getMeHandler);

export { router as meRoutes};