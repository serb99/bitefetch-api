import type { Request, Response } from 'express';
import { getCurrentOrder, pickUpOrder, deliverOrder, reportProblem } from '../services/courierOrderService';
import type { ReportProblemBody } from '../schemas/courierSchema';

async function getCurrentOrderHandler(req: Request, res: Response): Promise<void> {
    res.json({ order: await getCurrentOrder(req.user!.id) });
}

async function pickUpOrderHandler(req: Request<{ id: string }>, res: Response): Promise<void> {
    res.json(await pickUpOrder(req.user!.id, req.params.id));
}

async function deliverOrderHandler(req: Request<{ id: string }>, res: Response): Promise<void> {
    res.json(await deliverOrder(req.user!.id, req.params.id));
}

async function reportProblemHandler(req: Request<{ id: string }>, res: Response): Promise<void> {
    const { problem, created } = await reportProblem(req.user!.id, req.params.id, req.body as ReportProblemBody);
    res.status(created ? 201 : 200).json(problem);
}

export { getCurrentOrderHandler, pickUpOrderHandler, deliverOrderHandler, reportProblemHandler };
