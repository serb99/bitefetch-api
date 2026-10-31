import request from 'supertest';
import type { Response } from 'supertest';
import { app } from '../../src/app';

function api() {
    return request(app);
}

function setCookies(res: Response): string[] {
    const header = res.headers['set-cookie'] as unknown;
    if (!header) return [];
    return Array.isArray(header) ? header : [String(header)];
}

// The raw Set-Cookie line for refreshToken, with its attributes.
function refreshCookieLine(res: Response): string | undefined {
    return setCookies(res).find((line) => line.startsWith('refreshToken='));
}

// Only the cookie value.
function refreshTokenFrom(res: Response): string | undefined {
    const line = refreshCookieLine(res);
    if (!line) return undefined;
    return decodeURIComponent(line.split(';')[0].slice('refreshToken='.length));
}

interface LoginResult {
    res: Response;
    accessToken: string;
    refreshToken: string;
}

async function login(email: string, password: string): Promise<LoginResult> {
    const res = await api().post('/sessions').send({ email, password });
    if (res.status !== 201) {
        throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return { res, accessToken: res.body.accessToken, refreshToken: refreshTokenFrom(res)! };
}

function refresh(token?: string) {
    const req = api().post('/sessions/refresh');
    return token === undefined ? req : req.set('Cookie', `refreshToken=${token}`);
}

function logout(token?: string) {
    const req = api().delete('/sessions/current');
    return token === undefined ? req : req.set('Cookie', `refreshToken=${token}`);
}

// Links are printed with console.log (mocked in setupDb.ts). Read the token of the latest one.
const ACTIVATION_LINK = /Activation link: \S*[?&]token=([A-Za-z0-9_-]+)/;
const RESET_LINK = /Password reset link: \S*#token=([A-Za-z0-9_-]+)/;

function printedTokens(pattern: RegExp): string[] {
    return jest.mocked(console.log).mock.calls
        .map((args) => String(args[0]).match(pattern))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => match[1]);
}

function lastPrintedToken(pattern: RegExp): string {
    const tokens = printedTokens(pattern);
    if (tokens.length === 0) throw new Error(`No link matching ${pattern} was printed`);
    return tokens[tokens.length - 1];
}

const lastActivationToken = () => lastPrintedToken(ACTIVATION_LINK);
const lastResetToken = () => lastPrintedToken(RESET_LINK);
const printedResetTokens = () => printedTokens(RESET_LINK);
const printedActivationTokens = () => printedTokens(ACTIVATION_LINK);

export {
    api, refreshCookieLine, refreshTokenFrom, login, refresh, logout,
    lastActivationToken, lastResetToken, printedResetTokens, printedActivationTokens,
};
