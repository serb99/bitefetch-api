import type { Request, Response } from 'express';
import {
    listAddresses,
    createAddress,
    updateAddress,
    setDefaultAddress,
    deleteAddress,
} from '../services/addressService';

async function listAddressesHandler(req:Request, res: Response) {
    res.json(await listAddresses(req.user!.id));
}

async function createAddressHandler(req: Request, res: Response) {
    const address = await createAddress(req.user!.id, req.body);
    res.status(201).json(address);
}

async function updateAddressHandler(req: Request<{ id: string }>, res: Response) {
    res.json(await updateAddress(req.user!.id, req.params.id, req.body));
}

async function setDefaultAddressHandler(req: Request<{ id: string }>, res: Response) {
    res.json(await setDefaultAddress(req.user!.id, req.params.id));
}

async function deleteAddressHandler(req: Request<{ id: string }>, res: Response) {
    await deleteAddress(req.user!.id, req.params.id);
    res.status(204).end();
}

export {
    listAddressesHandler,
    createAddressHandler,
    updateAddressHandler,
    setDefaultAddressHandler,
    deleteAddressHandler,
};