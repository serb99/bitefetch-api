const orderItemService = require('../services/orderItemService');

async function getItemsByOrderId(req, res, next){
    const orderId = req.params.orderId;

    try{
        const items = await orderItemService.getItemsByOrderId(orderId);
        res.status(200).json(items);
    }
    catch(err){
        next(err);
    }
}

async function addOrderItem(req, res, next){
    const orderId = req.params.orderId;
    const orderItem = req.body;

    if(!orderItem.item_name || !orderItem.unit_price || !orderItem.quantity){
        return res.status(400).json({error: 'Missing required fields'});
    }

    try{
        const item = await orderItemService.addOrderItem(orderId, orderItem);
        res.status(201).json(item);  
    }
    catch(err){
        if(err.code === '23503'){
           return res.status(404).json({error: 'Order not found'});
        }
        next(err);
    }
}

async function updateItemQuantity(req, res, next){
    const itemId = req.params.id;
    const quantity = req.body.quantity;

    if(!quantity || quantity <= 0){
        return res.status(400).json({error: 'Quantity must be a positive number'});
    }
    try{
        const item = await orderItemService.updateItemQuantity(itemId, quantity);
        if(item){
            res.status(200).json(item);
        }
        else{
            res.status(404).json({error: 'Item not found'})
        }
    }
    catch(err){
        next(err);
    }
}

async function deleteOrderItem(req, res, next){
    const itemId = req.params.id;

    try{
        const item = await orderItemService.deleteOrderItem(itemId);

        if(item){
            res.status(200).json(item);
        }
        else{
            res.status(404).json({error: 'Item not found'})
        }
    }
    catch(err){
        next(err);
    }
}

module.exports = {getItemsByOrderId, addOrderItem, updateItemQuantity, deleteOrderItem};