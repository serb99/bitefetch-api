const customerService = require('../services/customerService');

async function getAllCustomers(req, res, next){
    try{
        const customers = await customerService.getAllCustomers();
        res.status(200).json(customers);
    }
    catch(err){
        next(err);   
    }
}

async function getCustomerById(req, res, next){
    const id = req.params.id;

    try{
        const customer = await customerService.getCustomerById(id);
        if(customer){
            res.status(200).json(customer);
        }
        else{
            res.status(404).json({ error: 'Customer not found'});
        }
    }
    catch(err){
        next(err);
    }
}

async function createCustomer(req, res, next){
    const customerData = req.body;

    if (!customerData.email || !customerData.first_name || !customerData.last_name || !customerData.phone) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try{
        const customer = await customerService.createCustomer(customerData);
        res.status(201).json(customer);
    }
    catch(err){
        next(err);
    }
}

async function updateCustomer(req, res, next){
    const id = req.params.id;
    const customerData = req.body;

    if (customerData == null || Object.keys(customerData).length === 0) {
        return res.status(400).json({ error: 'No data provided for update' });
    }

    try{
        const updatedCustomer = await customerService.updateCustomer(id, customerData);
        if(updatedCustomer){
            res.status(200).json(updatedCustomer);
        }
        else{
            res.status(404).json({ error: 'Customer not found' });
        }
    }
    catch(err){
        next(err);
    }
}

async function deleteCustomer(req, res, next){
    const id = req.params.id;

    try{
        const deletedCustomer = await customerService.deleteCustomer(id);

        if(deletedCustomer){
            res.status(200).json(deletedCustomer);
        }
        if(!deletedCustomer){
            res.status(404).json({ error: 'Customer not found' });
        }
    }
    catch(err){
        if(err.code === '23503') // foreign key violation
        {
            res.status(409).json({ error: 'Cannot delete customer with existing orders' });
        }
        else{
            next(err);
        }
    }
}

module.exports = { getAllCustomers, getCustomerById, createCustomer, updateCustomer, deleteCustomer};