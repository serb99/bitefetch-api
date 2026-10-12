const pool = require('../database/pool');
const bcrypt = require('bcrypt');

async function getAllCustomers(){
    try{
        const result = await pool.query('SELECT * FROM customers');
        const customers = result.rows.map(customer => {
            delete customer.password_hash;
            return customer;
        });
        return customers;
    }
    catch(err){
        console.error('Error fetching customers:', err);
        throw err;
    }
}

async function getCustomerById(id){
    try{
        const result = await pool.query("SELECT * FROM customers WHERE id = $1", [id]);
        const customer = result.rows[0];
        if (customer) {
            delete customer.password_hash; // Remove password hash before returning
        }
        return customer;
    }
    catch(err){
        console.error('Error fetching customer:', err);
        throw err;
    }
}

async function getCustomerByEmail(email){
    try{
        const result = await pool.query("SELECT * FROM customers WHERE email = $1", [email]);
        return result.rows[0];
    }
    catch(err){
        console.error('Error fetching customer by email:', err);
        throw err;  
    }
}

async function createCustomer(customerData){
    try{
        const saltRounds = 10;
        const passwordHash = await bcrypt.hash(customerData.password, saltRounds);
        const result = await pool.query("INSERT INTO customers (first_name, last_name, email, phone, destination_address, password_hash) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *", [customerData.first_name, 
                         customerData.last_name, customerData.email, customerData.phone, customerData.destination_address, passwordHash]);
        
        const customer = result.rows[0];
        delete customer.password_hash; // Remove password hash before returning
        return customer;
    }
    catch(err){
        console.error('Error creating customer:', err);
        throw err;
    }
}

async function updateCustomer(id, customerData){
    const fragments = [];
    const values = [];
    let index = 1;
    
    for (const key in customerData){
        fragments.push(`${key} = $${index}`);
        values.push(customerData[key]);
        index++;
    }

    try{
        const result = await pool.query(`UPDATE customers SET ${fragments.join(', ')} WHERE id = $${index} RETURNING *`, [...values, id]);
        
        const customer = result.rows[0];
        if(customer){
            delete customer.password_hash; // Remove password hash before returning
        }
        return customer;
    }
    catch(err){
        console.error('Error updating customer:', err);
        throw err;
    }
}

async function deleteCustomer(id){
    try{
        const result = await pool.query("DELETE FROM customers WHERE id = $1 RETURNING *", [id]);
        const customer = result.rows[0];
        if (customer){
            delete customer.password_hash; // Remove password hash before returning
        }
        return customer;
    }
    catch(err){
        console.error('Error deleting customer:', err);
        throw err;
    }
}

module.exports = { getAllCustomers, getCustomerById, createCustomer, updateCustomer, deleteCustomer, getCustomerByEmail};