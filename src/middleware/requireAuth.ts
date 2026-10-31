import type { Request, Response, NextFunction } from 'express';
import { TokenExpiredError } from 'jsonwebtoken';
import { verifyAccessToken } from '../utils/jwt';
import { accessTokenExpired, unauthenticated } from '../errors/authErrors';

function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const header = req.headers.authorization;

    if (!header || !header.startsWith('Bearer ')) {
        throw unauthenticated();
    }

    const token = header.slice(7);

    try{
        req.user = verifyAccessToken(token);
    } catch (err) {
        if (err instanceof TokenExpiredError) {
            throw accessTokenExpired();
        }
        throw unauthenticated();
    }

    next();
}

export { requireAuth };