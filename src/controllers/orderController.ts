import type { Request, Response } from 'express';
import { AppError } from '../errors/AppError';
import { idempotencyKeySchema } from '../schemas/checkoutSchema';
import { createOrder } from '../services/checkoutService';
import { listCustomerOrders, getCustomerOrder } from '../services/orderService';
import { listOrdersQuerySchema } from '../schemas/orderSchema';

async function createOrderHandler(req: Request, res: Response) {
    // the key travels in a header, not in the body
    const key = idempotencyKeySchema.safeParse(req.header('Idempotency-Key'));
    if (!key.success) {
        throw new AppError(400, 'VALIDATION_ERROR', 'The Idempotency-Key header is required (1 to 100 characters)');
    }

    const { order, created } = await createOrder(req.user!.id, key.data, req.body.expectedTotalMinor);
    res.status(created ? 201 : 200).json(order);
}

async function listOrdersHandler(req: Request, res: Response) {
    // req.query is read-only, so it will be parsed here instead of in a middleware
    const query = listOrdersQuerySchema.safeParse(req.query);
    if (!query.success) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid query parameters', query.error.issues);
    }
    res.json(await listCustomerOrders(req.user!.id, query.data.limit, query.data.before));
}

async function getOrderHandler(req: Request<{ id: string }>, res: Response) {
    res.json(await getCustomerOrder(req.user!.id, req.params.id));
}

export { createOrderHandler, listOrdersHandler, getOrderHandler};