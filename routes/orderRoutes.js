const express = require('express');
const orderController = require('../controllers/orderController');
const orderItemRoutes = require('./orderItemRoutes');

const router = express.Router();

router.get('/', orderController.getAllOrders);
router.get('/:id', orderController.getOrderById);
router.post('/', orderController.createOrder);
router.patch('/:id', orderController.updateOrder);
router.delete('/:id', orderController.deleteOrder);

router.use('/:orderId/items', orderItemRoutes);

module.exports = router;