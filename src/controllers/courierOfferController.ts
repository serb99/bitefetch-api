import type { Request, Response } from 'express';
import { getCurrentOffer, acceptOffer, declineOffer } from '../services/courierOfferService';
import type { DeclineOfferBody } from '../schemas/courierSchema';

async function getCurrentOfferHandler(req: Request, res: Response): Promise<void> {
    res.json({ offer: await getCurrentOffer(req.user!.id) });
}

async function acceptOfferHandler(req: Request<{ id: string }>, res: Response): Promise<void> {
    res.json(await acceptOffer(req.user!.id, req.params.id));
}

async function declineOfferHandler(req: Request<{ id: string }>, res: Response): Promise<void> {
    res.json(await declineOffer(req.user!.id, req.params.id, req.body as DeclineOfferBody));
}

export { getCurrentOfferHandler, acceptOfferHandler, declineOfferHandler };