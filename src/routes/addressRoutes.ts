import { Router } from 'express';
import { requireAuth } from '../middleware/requireAuth';
import { requireRole } from '../middleware/requireRole';
import { validate } from '../middleware/validate';
import { validateIdParam } from '../middleware/validateIdParam';
import { createAddressSchema, updateAddressSchema } from '../schemas/addressSchema';
import {
    listAddressesHandler,
    createAddressHandler,
    updateAddressHandler,
    setDefaultAddressHandler,
    deleteAddressHandler,
} from '../controllers/addressController';

const router = Router();

router.use(requireAuth, requireRole('customer'));

router.get('/', listAddressesHandler);
router.post('/', validate(createAddressSchema), createAddressHandler);
router.patch('/:id', validateIdParam, validate(updateAddressSchema), updateAddressHandler);
router.put('/:id/default', validateIdParam, setDefaultAddressHandler);
router.delete('/:id', validateIdParam, deleteAddressHandler);

export { router as addressRoutes };