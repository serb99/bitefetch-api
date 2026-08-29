const pool = require('../database/pool');

async function getAllOrders(){
    try{
        const result = await pool.query('SELECT * FROM orders');
        return result.rows;
    }
    catch(err){
        console.error('Error fetching orders:', err);
        throw err;
    }
}

async function getOrderById(id){
    try{
        const result = await pool.query("SELECT * FROM orders WHERE id = $1", [id]);
        return result.rows[0];
    }
    catch(err){
        console.error('Error fetching order:', err);
        throw err;
    }
}

async function createOrder(orderData){
    const client = await pool.connect(); //manually requesting a connection to perform the transaction

    try{
        await client.query('BEGIN');

        //calculate total from the items
        const total = orderData.items.reduce((sum, item) => sum + item.unit_price * item.quantity, 0);
        
        //insert the order first, get its new id back
        const orderResult = await client.query('INSERT INTO orders (customer_id, status, total) VALUES ($1, $2, $3) RETURNING *', 
            [orderData.customer_id, 'pending', total]
        );
        const newOrder = orderResult.rows[0];

        //insert each item, using the new order's id
        for(const item of orderData.items){
            await client.query(
                'INSERT INTO order_items (order_id, item_name, unit_price, quantity) VALUES ($1, $2, $3, $4)',
                [newOrder.id, item.item_name, item.unit_price, item.quantity]
            );
        }

        await client.query('COMMIT');
        return newOrder;
    }
    catch(err){
        await client.query('ROLLBACK');
        console.error('Error creating order:', err);
        throw err;
    }
    finally{
        client.release();
    }
}

async function updateOrder(id, status){
    try{
        let result;
        if(status === 'delivered'){
            result = await pool.query(
                'UPDATE orders SET status = $1, delivered_at = NOW() WHERE id = $2 RETURNING *', 
            [status, id]);
        }
        else{
            result = await pool.query(
                'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *', 
                [status, id]);
        }
        return result.rows[0];
    }
    catch(err){
        console.error('Error updating order status:', err);
        throw err;
    }
}

async function deleteOrder(id){
    const client = await pool.connect();

    try{
        await client.query('BEGIN');
        await client.query('DELETE FROM order_items WHERE order_id = $1', [id]);
        
        const result = await client.query('DELETE FROM orders WHERE id = $1 RETURNING *', [id]);
        await client.query('COMMIT');
        return result.rows[0];
    }
    catch(err){
        await client.query('ROLLBACK');
        console.error('Error deleting order:', err);
        throw err;
    }
    finally{
        client.release();
    }
}

module.exports = {getAllOrders, getOrderById, createOrder, updateOrder, deleteOrder};