import type { Request, Response } from 'express';
import { getMe } from '../services/userService';

async function getMeHandler(req: Request, res: Response) {
    const me = await getMe(req.user!.id);
    res.json(me);
}

export { getMeHandler };