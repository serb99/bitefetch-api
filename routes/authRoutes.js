const express = require('express');
const authController = require('../controllers/authController');
const requireAuth = require('../middleware/requireAuth');
const router = express.Router();

router.post('/login', authController.loginCustomer);
router.post('/logout', authController.logoutCustomer);
router.get('/me', requireAuth, authController.getCurrentCustomer);

module.exports = router;