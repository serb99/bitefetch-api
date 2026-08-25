const customerService = require('../services/customerService');

async function getAllCustomers(req, res){
    try{
        const customers = await customerService.getAllCustomers();
        res.status(200).json(customers);
    }
    catch(err){
        console.error('Error in getAllCustomers controller:', err);
        res.status(500).json({ error: 'Internal Server Error' });   
    }
}

async function getCustomerById(req, res){
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
        console.error('Error in getCustomerById controller:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}

async function createCustomer(req, res){
    const customerData = req.body;

    if (!customerData.email || !customerData.first_name || !customerData.last_name || !customerData.phone) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try{
        const customer = await customerService.createCustomer(customerData);
        res.status(201).json(customer);
    }
    catch(err){
        console.error('Error in createCustomer controller:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}

async function updateCustomer(req, res){
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
        console.error('Error in updateCustomer controller:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}

async function deleteCustomer(req, res){
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
            console.error('Error in deleteCustomer controller:', err);
            res.status(500).json({ error: 'Internal Server Error' });
        }
    }
}

module.exports = { getAllCustomers, getCustomerById, createCustomer, updateCustomer, deleteCustomer };