import type { Request, Response, NextFunction } from 'express';
import type { UserRole } from '../types/auth';
import { unauthenticated, forbidden } from '../errors/authErrors';

function requireRole(...allowed: UserRole[]){
    return (req: Request, res: Response, next: NextFunction): void => {
        if (!req.user) {
            throw unauthenticated();
        }

        if (!allowed.includes(req.user.role)) {
            throw forbidden();
        }

        next();
    };
}

export { requireRole };