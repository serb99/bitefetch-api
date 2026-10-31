import { Request, Response } from 'express';
import { requestPasswordReset, confirmPasswordReset  } from '../services/passwordResetService';

async function requestResetHandler(req:Request, res: Response): Promise<void>{
    await requestPasswordReset(req.body);
    res.status(202).json({ message: 'If an account exists for this email, a reset link has been sent.' });
}

async function confirmResetHandler(req: Request, res: Response): Promise<void>{
    await confirmPasswordReset(req.body);
    res.status(204).send();
}

export { requestResetHandler, confirmResetHandler  };