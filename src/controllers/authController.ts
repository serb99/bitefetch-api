import { Request, Response } from 'express';
import { activateAccount, signupCustomer, signupOwner, signupCourier } from '../services/authService';

async function signupCustomerHandler(req: Request, res: Response): Promise<void>{
    const user = await signupCustomer(req.body);
    res.status(201).json({ user });
}

async function signupOwnerHandler(req: Request, res: Response): Promise<void>{
    const user = await signupOwner(req.body);
    res.status(201).json({ user });
}

async function signupCourierHandler(req: Request, res: Response): Promise<void>{
    const user = await signupCourier(req.body);
    res.status(201).json({ user });
}

async function activateHandler(req: Request, res: Response): Promise<void>{
    const status = await activateAccount(req.body.token);
    const message = status === 'active'
        ? 'Account activated'
        : 'Email confirmed, waiting for admin approval';
    res.status(200).json({status, message});
}

export { signupCustomerHandler, signupOwnerHandler, signupCourierHandler, activateHandler};