const pool = require('../database/pool');

async function getItemsByOrderId(orderId){
    try{
        const result = await pool.query('SELECT * from order_items WHERE order_id = $1', 
            [orderId]
        );
        return result.rows;
    }
    catch(err){
        console.error('Error fetching order items:', err);
        throw err;
    }
}

async function addOrderItem(orderId, itemData){
    try{
        const result = await pool.query(
            `INSERT INTO order_items (order_id, item_name, unit_price, quantity) 
             VALUES ($1, $2, $3, $4) RETURNING *`, 
            [orderId, itemData.item_name, itemData.unit_price, itemData.quantity]);
        return result.rows[0];
    }
    catch(err){
        console.error('Error adding order item:', err);
        throw err;
    }
}

async function updateItemQuantity(id, quantity){
    try{
        const result = await pool.query(
            `UPDATE order_items SET quantity = $1 WHERE id = $2 RETURNING *`, 
            [quantity, id]
        );
        return result.rows[0];
    }
    catch(err){
        console.error('Error update item quantity:', err);
        throw err;
    }
}

async function deleteOrderItem(id){
    try{
        const result = await pool.query(
            `DELETE from order_items WHERE id = $1 RETURNING *`,
            [id]
        );
        return result.rows[0];
    }
    catch(err){
        console.error('Error deleting order item:', err);
        throw err;
    }
}

module.exports = {getItemsByOrderId, addOrderItem, updateItemQuantity, deleteOrderItem};