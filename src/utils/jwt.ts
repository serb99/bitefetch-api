import jwt from 'jsonwebtoken';
import type { AuthenticatedUser } from '../types/auth';
import { isUserRole } from '../types/auth';

function requireEnv(name: string): string {
    const value = process.env[name]; 

    if (!value) throw new Error(`${name} is not set`);   
    return value;                             
}

const JWT_SECRET = requireEnv('JWT_SECRET');
const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

export interface AccessClaims extends AuthenticatedUser {
    sid: string;
}

function signAccessToken(user: AuthenticatedUser, sid: string): string {
    return jwt.sign(
        { role: user.role, sid},
        JWT_SECRET,
        { subject: user.id, expiresIn: ACCESS_TOKEN_TTL_SECONDS, algorithm: 'HS256' }
    );
}

function verifyAccessToken(token: string): AccessClaims{
    // The algorithms option stops the library from trusting the algorithm named in the token header.
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });

    // verify() returns string | JwtPayload, and JwtPayload fields are optional/untyped.
    // A token signed with our secret but with a wrong shape is still rejected.
    if (
        typeof payload === 'string' ||
        typeof payload.sub !== 'string' ||
        typeof payload.sid !== 'string' ||
        !isUserRole(payload.role)
    ){
        throw new jwt.JsonWebTokenError('Malformed token payload');
    }

    return { id: payload.sub, role: payload.role, sid: payload.sid };
}

export { signAccessToken, verifyAccessToken };