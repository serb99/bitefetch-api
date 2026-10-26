import { Request, Response } from 'express';
import { activateAccount, signupCustomer } from '../services/authService';

async function signup(req: Request, res: Response): Promise<void>{
    const user = await signupCustomer(req.body);
    res.status(201).json({ user });
}

async function activate(req: Request, res: Response): Promise<void>{
    await activateAccount(req.body.token);
    res.status(200).json({ message: 'Account activated' });
}

export { signup, activate};