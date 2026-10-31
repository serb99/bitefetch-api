import type { AccessClaims } from '../utils/jwt';

declare global {
   namespace Express {
     interface Request {
      user?: AccessClaims;
    }
   }
 }