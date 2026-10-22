import {AppError} from '../errors/AppError';
import { Request, Response, NextFunction } from 'express';

function notFound(req: Request, _res: Response, next: NextFunction) {
    next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.originalUrl} not found`));
}

export { notFound };