const express = require('express');
const customerRoutes = require('./routes/customerRoutes');
const orderRoutes = require('./routes/orderRoutes');
const authRoutes = require('./routes/authRoutes');
const errorHandler = require('./middleware/errorHandler');
const session = require('express-session');
const app = express();

app.use(express.json());
app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {httpOnly: true, maxAge: 1000 * 60 * 60} //1 hour
}));

app.use('/auth', authRoutes);
app.use('/customers', customerRoutes);
app.use('/orders', orderRoutes);
app.use(errorHandler);

module.exports = app;