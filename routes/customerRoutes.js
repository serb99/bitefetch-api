const express = require('express');
const customerController = require('../controllers/customerController');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

router.post('/', customerController.createCustomer);
router.use(requireAuth); // Apply authentication middleware to all customer routes

router.get('/', customerController.getAllCustomers);
router.get('/:id', customerController.getCustomerById);
router.patch('/:id', customerController.updateCustomer);
router.delete('/:id', customerController.deleteCustomer);

module.exports = router;