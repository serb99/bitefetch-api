import type { Request, Response } from 'express';
import { getCourierState, updatePosition, setAvailability } from '../services/courierService';
import type { CourierPositionBody, CourierAvailabilityBody } from '../schemas/courierSchema';

async function getCourierStateHandler(req: Request, res: Response): Promise<void> {
    res.json(await getCourierState(req.user!.id));
}

// Sent every ~3 s: nothing to answer, so no body
async function updatePositionHandler(req: Request, res: Response): Promise<void> {
    await updatePosition(req.user!.id, req.body as CourierPositionBody);
    res.status(204).end();
}

async function setAvailabilityHandler(req: Request, res: Response): Promise<void> {
    const { online } = req.body as CourierAvailabilityBody;
    res.json(await setAvailability(req.user!.id, online));
}

export { getCourierStateHandler, updatePositionHandler, setAvailabilityHandler };