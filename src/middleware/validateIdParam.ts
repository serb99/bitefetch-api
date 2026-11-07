import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../errors/AppError';

function validateIdParam(req: Request, res: Response, next: NextFunction): void {
    const id = req.params.id;

    if (typeof id !== 'string' || !/^\d{1,18}$/.test(id)) {
        throw new AppError(400, 'VALIDATION_ERROR', 'Invalid id');
    }

    next();
}

export { validateIdParam };