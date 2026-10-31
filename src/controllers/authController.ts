import { Request, Response } from 'express';
import { loginUser, startSession, rotateSession, endSession } from '../services/authService';
import { AppError } from '../errors/AppError';

const REFRESH_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days, in milliseconds
const REFRESH_COOKIE_OPTIONS = { httpOnly: true, sameSite: 'strict' as const, secure: process.env.NODE_ENV === 'production', path: '/sessions' };

function setRefreshCookie(res: Response, refreshToken: string): void{
    res.cookie('refreshToken', refreshToken, {
        ...REFRESH_COOKIE_OPTIONS,
        maxAge: REFRESH_COOKIE_MAX_AGE_MS
    });
}

async function loginHandler(req: Request, res: Response): Promise<void>{
    const user = await loginUser(req.body);
    const session = await startSession(user);
    setRefreshCookie(res, session.refreshToken); 
    res.status(201).json({ accessToken: session.accessToken });
}

async function refreshHandler(req: Request, res: Response): Promise<void> {
    const token = req.cookies.refreshToken;

    if(typeof token !== 'string' || token === '') {
        throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Invalid refresh token');
    }

    const session = await rotateSession(token);
    setRefreshCookie(res, session.refreshToken);
    res.status(200).json({ accessToken: session.accessToken });
}

async function logoutHandler(req: Request, res: Response): Promise<void> {
    const token = req.cookies.refreshToken;

    if(typeof token === 'string' && token !== ''){
        await endSession(token);
    }

    res.clearCookie('refreshToken', REFRESH_COOKIE_OPTIONS);
    res.status(204).send();
}

export { loginHandler, refreshHandler, logoutHandler };