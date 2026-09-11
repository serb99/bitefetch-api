const express = require('express');
const authController = require('../controllers/authController');

const router = express.Router();

router.post('/login', authController.loginCustomer);
router.post('/logout', authController.logoutCustomer);

module.exports = router;