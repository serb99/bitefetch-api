const customerService = require('../services/customerService');
const bcrypt = require('bcrypt');

async function loginCustomer(req, res, next){
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    try{
        const customer = await customerService.getCustomerByEmail(email);
        if(!customer){
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        const passwordMatch = await bcrypt.compare(password, customer.password_hash);
        if(!passwordMatch){
            return res.status(401).json({ error: 'Invalid email or password' });
        }
        
        req.session.customerId = customer.id;
        delete customer.password_hash; // Remove password hash before returning
        res.status(200).json(customer);
    }
    catch(err){
        next(err);
    }
}

async function logoutCustomer(req, res, next){
    req.session.destroy((err) => {
        if (err){
            return next(err);
        }
        res.clearCookie('connect.sid');
        res.status(200).json({ message: 'Logged out successfully' });
    })
}

module.exports = { loginCustomer, logoutCustomer };