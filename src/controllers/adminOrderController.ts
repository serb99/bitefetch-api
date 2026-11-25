import type { Request, Response } from 'express';
import {
    getAdminOrder,
    adminCancelOrder,
    adminMarkPickedUp,
    adminMarkDelivered,
    retryDispatch,
    reassignCourier,
    approveCancelRequest,
    rejectCancelRequest
} from '../services/adminOrderService';
import type { AdminReasonBody, AdminVersionBody } from '../schemas/adminSchema';

type IdRequest = Request<{ id: string }>;

async function getAdminOrderHandler(req: IdRequest, res: Response): Promise<void> {
    res.json(await getAdminOrder(req.params.id));
}

async function adminCancelOrderHandler(req: IdRequest, res: Response): Promise<void> {
    res.json(await adminCancelOrder(req.user!.id, req.params.id, req.body as AdminReasonBody));
}

async function adminMarkPickedUpHandler(req: IdRequest, res: Response): Promise<void> {
    res.json(await adminMarkPickedUp(req.user!.id, req.params.id, req.body as AdminReasonBody));
}

async function adminMarkDeliveredHandler(req: IdRequest, res: Response): Promise<void> {
    res.json(await adminMarkDelivered(req.user!.id, req.params.id, req.body as AdminReasonBody));
}

async function retryDispatchHandler(req: IdRequest, res: Response): Promise<void> {
    res.json(await retryDispatch(req.user!.id, req.params.id, req.body as AdminVersionBody));
}

async function reassignCourierHandler(req: IdRequest, res: Response): Promise<void> {
    res.json(await reassignCourier(req.user!.id, req.params.id, req.body as AdminReasonBody));
}

async function approveCancelRequestHandler(req: IdRequest, res: Response): Promise<void> {
    res.json(await approveCancelRequest(req.user!.id, req.params.id, req.body as AdminVersionBody));
}

async function rejectCancelRequestHandler(req: IdRequest, res: Response): Promise<void> {
    res.json(await rejectCancelRequest(req.user!.id, req.params.id, req.body as AdminVersionBody));
}

export {
    getAdminOrderHandler,
    adminCancelOrderHandler,
    adminMarkPickedUpHandler,
    adminMarkDeliveredHandler,
    retryDispatchHandler,
    reassignCourierHandler,
    approveCancelRequestHandler,
    rejectCancelRequestHandler
};
