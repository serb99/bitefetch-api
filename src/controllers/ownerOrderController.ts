import type { Request, Response } from 'express';
import {
    listOwnerActiveOrders,
    acceptOrder,
    rejectOrder,
    markOrderReady,
    ownerCancelOrder,
    requestOrderCancellation
} from '../services/ownerOrderService';
import type { AcceptOrderBody, RejectOrderBody, OwnerCancelOrderBody, CancelRequestBody } from '../schemas/ownerOrderSchema';

async function requestCancellationHandler(req: Request<{ id: string }>, res: Response): Promise<void> {
    const { request, created } = await requestOrderCancellation(req.user!.id, req.params.id, req.body as CancelRequestBody);
    res.status(created ? 201 : 200).json(request);
}

async function listActiveOrdersHandler(req: Request, res: Response): Promise<void> {
    res.json(await listOwnerActiveOrders(req.user!.id));
}

async function acceptOrderHandler(req: Request<{ id: string }>, res: Response): Promise<void> {
    const body = req.body as AcceptOrderBody;
    res.json(await acceptOrder(req.user!.id, req.params.id, body.prepMinutes));
}

async function rejectOrderHandler(req: Request<{ id: string }>, res: Response): Promise<void> {
    res.json(await rejectOrder(req.user!.id, req.params.id, req.body as RejectOrderBody));
}

async function markReadyHandler(req: Request<{ id: string }>, res: Response): Promise<void> {
    res.json(await markOrderReady(req.user!.id, req.params.id));
}

async function ownerCancelOrderHandler(req: Request<{ id: string }>, res: Response): Promise<void> {
    res.json(await ownerCancelOrder(req.user!.id, req.params.id, req.body as OwnerCancelOrderBody));
}

export {
    listActiveOrdersHandler,
    acceptOrderHandler,
    rejectOrderHandler,
    markReadyHandler,
    ownerCancelOrderHandler,
    requestCancellationHandler
};