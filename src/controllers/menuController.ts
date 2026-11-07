import type { Request, Response } from 'express';
import { createMenuItem, listOwnerMenu, updateMenuItem, setItemAvailability  } from '../services/menuService';

async function createMenuItemHandler(req: Request, res: Response): Promise<void> {
    const item = await createMenuItem(req.user!.id, req.body);
    res.status(201).json(item);
}

async function updateMenuItemHandler(req: Request<{ id: string }>, res: Response): Promise<void> {
    const item = await updateMenuItem(req.user!.id, req.params.id, req.body);
    res.json(item);
}

async function listOwnerMenuHandler(req: Request, res: Response): Promise<void> {
    res.json(await listOwnerMenu(req.user!.id));
}

async function setAvailabilityHandler(req: Request<{ id: string }>, res: Response): Promise<void> {
    const result = await setItemAvailability(req.user!.id, req.params.id, req.body.available); 
    res.json(result);
}

export { createMenuItemHandler, updateMenuItemHandler, listOwnerMenuHandler, setAvailabilityHandler };