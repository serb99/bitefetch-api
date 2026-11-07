import rateLimit, { ipKeyGenerator, type Options } from 'express-rate-limit';
import { AppError } from '../errors/AppError';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function limiter(windowMs: number, limit: number, keyGenerator?: Options['keyGenerator']) {
    return rateLimit({
        windowMs,
        limit,
        standardHeaders: 'draft-7',
        legacyHeaders: false,
        keyGenerator,               // undefined -> the library's default, the client IP
        skip: () => process.env.RATE_LIMIT_DISABLED === 'true',
        // Same JSON error shape as every other error, through the central handler.
        handler: (req, res, next) => {
            next(new AppError(429, 'RATE_LIMITED', 'Too many requests, try again later'));
        },
    });
}

// Limiters run before validate(),
// so without this, "Ana@x.com" and "ana@x.com" would be counted as two different people.
function bodyEmail(body: unknown): string {
    const email = (body as { email?: unknown } | undefined)?.email;
    return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// 5 attempts per minute per (IP, email): stops guessing one account from one machine.
const ipAndEmailKey: Options['keyGenerator'] = (req) =>
    `${ipKeyGenerator(req.ip ?? '')}|${bodyEmail(req.body)}`;

// 3 reset emails per hour for one address, from anywhere: caps the mail sent to one inbox.
const emailKey: Options['keyGenerator'] = (req) =>
    bodyEmail(req.body) || ipKeyGenerator(req.ip ?? '');

export const signupLimiter = limiter(HOUR, 5);
export const loginLimiter = limiter(MINUTE, 5, ipAndEmailKey);
export const passwordResetLimiter = limiter(HOUR, 3, emailKey);
export const osmSearchLimiter = limiter(60 * 1000, 20);