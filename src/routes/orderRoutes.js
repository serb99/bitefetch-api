const express = require('express');
const orderController = require('../controllers/orderController');
const orderItemRoutes = require('./orderItemRoutes');
const requireAuth = require('../middleware/requireAuth');

const router = express.Router();

router.use(requireAuth); // Apply authentication middleware to all order routes

router.get('/', orderController.getAllOrders);
router.get('/:id', orderController.getOrderById);
router.post('/', orderController.createOrder);
router.patch('/:id', orderController.updateOrder);
router.delete('/:id', orderController.deleteOrder);

router.use('/:orderId/items', orderItemRoutes);

module.exports = router;