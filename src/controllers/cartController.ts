import type { Request, Response } from 'express';
import {
    getCartView,
    setCartItem,
    removeCartItem,
    clearCart,
    setCartAddress,
} from '../services/cartService';

async function getCartHandler(req: Request, res: Response) {
    res.json(await getCartView(req.user!.id));
}

async function setCartItemHandler(req: Request<{ id: string }>, res: Response) {
    res.json(await setCartItem(req.user!.id, req.params.id, req.body));
}

async function removeCartItemHandler(req: Request<{ id: string }>, res: Response) {
    res.json(await removeCartItem(req.user!.id, req.params.id));
}

async function clearCartHandler(req: Request, res: Response) {
    res.json(await clearCart(req.user!.id));
}

async function setCartAddressHandler(req: Request, res: Response) {
    res.json(await setCartAddress(req.user!.id, req.body.addressId));
}

export {
    getCartHandler,
    setCartItemHandler,
    removeCartItemHandler,
    clearCartHandler,
    setCartAddressHandler,
};