const express = require('express');
const orderItemController = require('../controllers/orderItemController');

const router = express.Router({mergeParams: true});

router.get('/', orderItemController.getItemsByOrderId);
router.post('/', orderItemController.addOrderItem);
router.patch('/:id', orderItemController.updateItemQuantity);
router.delete('/:id', orderItemController.deleteOrderItem);

module.exports = router;