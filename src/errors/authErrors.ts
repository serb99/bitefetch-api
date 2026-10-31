import { AppError } from './AppError';

export const unauthenticated = () => new AppError(401, 'UNAUTHENTICATED', 'Authentication required');
export const accessTokenExpired = () => new AppError(401, 'ACCESS_TOKEN_EXPIRED', 'Access token expired');
export const sessionEnded = () => new AppError(401, 'SESSION_ENDED', 'Session has ended');
export const forbidden = () => new AppError(403, 'FORBIDDEN', "You don't have access to this resource");