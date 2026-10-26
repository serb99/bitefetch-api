import { randomBytes, createHash } from "node:crypto";

function generateToken(): string {
    return randomBytes(32).toString('base64url');
}

function hashToken(token: string) : string {
    return createHash('sha256').update(token).digest('hex');
}

export { generateToken, hashToken };