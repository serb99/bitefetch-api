const orderService = require('../services/orderService');

async function getAllOrders(req, res){
    try{
        const orders = await orderService.getAllOrders();
        res.status(200).json(orders);
    }
    catch(err){
        console.error('Error in getAllOrders controller:', err);
        res.status(500).json({error: 'Internal Server Error'});
    }
}

async function getOrderById(req, res){
    const id = req.params.id;

    try{
        const order = await orderService.getOrderById(id);
        if(order){
            res.status(200).json(order);
        }
        else{
            res.status(404).json({ error: 'Order not found'});
        }
    }
    catch(err){
        console.error('Error in getOrderById controller:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}

async function createOrder(req, res){
    const orderData = req.body;

    if (!orderData.customer_id || !orderData.items || orderData.items.length === 0) {
        return res.status(400).json({ error: 'customer_id and at least one item are required' });
    }

    const itemsValid = orderData.items.every(item => 
        item.item_name && item.unit_price && item.quantity
    )

    if(!itemsValid){
        return res.status(400).json({error: 'Each item must have item_name, unit_price, and quantity'});
    }

    try{
        const order = await orderService.createOrder(orderData);
        res.status(201).json(order);
    }
    catch(err){
        console.error('Error in createOrder controller:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}

async function updateOrder(req, res){
    const id = req.params.id;
    const orderStatus = req.body.status;

    if(orderStatus == null || Object.keys(orderStatus).length === 0){
        return res.status(400).json({ error: 'No data provided for update' });
    }

    try{
        const updatedOrder = await orderService.updateOrder(id, orderStatus);
        if(updatedOrder){
            res.status(200).json(updatedOrder);
        }
        else{
            res.status(404).json({ error: 'Order not found' });
        }
    }
    catch(err){
        console.error('Error in updateOrder controller:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}

async function deleteOrder(req, res){
    const id = req.params.id;

    try{
        const deletedOrder = await orderService.deleteOrder(id);
        if(deletedOrder){
            res.status(200).json(deletedOrder);
        }
        else{
            res.status(404).json({error: 'Order not found'});
        }
    }
    catch(err){
        console.error('Error in deleteOrder controller:', err);
        res.status(500).json({ error: 'Internal Server Error' });
    }
}

module.exports = { getAllOrders, getOrderById, createOrder, updateOrder, deleteOrder };