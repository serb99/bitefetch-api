const express = require('express');
const customerRoutes = require('./routes/customerRoutes');
const orderRoutes = require('./routes/orderRoutes');
const errorHandler = require('./middleware/errorHandler');

const app = express();

app.use(express.json());
app.use('/customers', customerRoutes);
app.use('/orders', orderRoutes);
app.use(errorHandler);

module.exports = app;