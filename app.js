const express = require('express');
const customerRoutes = require('./routes/customerRoutes');

const app = express();

app.use(express.json());
app.use('/customers', customerRoutes);

module.exports = app;