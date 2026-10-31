import { api } from '../../helpers/http';
import { countRows } from '../../helpers/db';
import { createUser } from '../../helpers/users';

// Every test file gets its own module registry, so the limiters' in-memory counters start empty
// here and are not shared with other files. Inside this file they persist between tests, so each
// test uses its own emails, and only one test may use up the per-IP signup limit.
// The skip() option reads RATE_LIMIT_DISABLED on every request, so it can be switched on here.
const previous = process.env.RATE_LIMIT_DISABLED;
beforeAll(() => { process.env.RATE_LIMIT_DISABLED = 'false'; });
afterAll(() => { process.env.RATE_LIMIT_DISABLED = previous; });

const RATE_LIMITED = { error: { code: 'RATE_LIMITED', message: 'Too many requests, try again later', details: null } };

function expectLimited(res: { status: number; body: unknown; headers: Record<string, string> }) {
    expect(res.status).toBe(429);
    expect(res.body).toEqual(RATE_LIMITED);
    expect(res.headers['ratelimit']).toMatch(/remaining=0/);
}

describe('signupLimiter (5 per hour per IP)', () => {
    it('accepts 5 signups from one IP, then answers 429 and creates nothing', async () => {
        for (let i = 1; i <= 5; i++) {
            const res = await api().post('/customers')
                .send({ email: `signup${i}@example.com`, password: 'Str0ngPassw0rd', fullName: 'Ana Pop' });
            expect(res.status).toBe(201);
            expect(res.headers['ratelimit-policy']).toMatch(/^5;w=3600/);
        }

        const res = await api().post('/customers')
            .send({ email: 'signup6@example.com', password: 'Str0ngPassw0rd', fullName: 'Ana Pop' });

        expectLimited(res);
        expect(await countRows('users')).toBe(5);
    });
});

describe('loginLimiter (5 per minute per IP + email)', () => {
    it('blocks the 6th attempt for one email, even with the right password', async () => {
        const user = await createUser({ email: 'login.a@example.com' });
        for (let i = 0; i < 5; i++) {
            expect((await api().post('/sessions').send({ email: user.email, password: 'Wr0ngPassword' })).status).toBe(401);
        }

        const res = await api().post('/sessions').send({ email: user.email, password: user.password });

        expectLimited(res);
        expect(await countRows('refresh_tokens')).toBe(0);
    });

    it('counts the email case-insensitively and ignores surrounding spaces', async () => {
        const user = await createUser({ email: 'login.b@example.com' });
        const variants = ['login.b@example.com', 'LOGIN.B@example.com', ' login.b@EXAMPLE.com ', 'Login.B@Example.Com', 'login.b@example.com'];
        for (const email of variants) {
            expect((await api().post('/sessions').send({ email, password: 'Wr0ngPassword' })).status).toBe(401);
        }

        expectLimited(await api().post('/sessions').send({ email: 'LOGIN.b@example.com', password: user.password }));
    });

    it('still lets another email log in from the same IP', async () => {
        await createUser({ email: 'login.c@example.com' });
        const other = await createUser({ email: 'login.d@example.com' });
        for (let i = 0; i < 6; i++) {
            await api().post('/sessions').send({ email: 'login.c@example.com', password: 'Wr0ngPassword' });
        }

        const res = await api().post('/sessions').send({ email: other.email, password: other.password });

        expect(res.status).toBe(201);
    });
});

describe('passwordResetLimiter (3 per hour per email)', () => {
    it('accepts 3 requests for one email, then answers 429', async () => {
        for (let i = 0; i < 3; i++) {
            expect((await api().post('/password-resets').send({ email: 'reset.a@example.com' })).status).toBe(202);
        }

        expectLimited(await api().post('/password-resets').send({ email: 'reset.a@example.com' }));
    });

    it('counts the email case-insensitively and ignores surrounding spaces', async () => {
        for (const email of ['reset.b@example.com', 'RESET.B@example.com', '  reset.b@Example.com ']) {
            expect((await api().post('/password-resets').send({ email })).status).toBe(202);
        }

        expectLimited(await api().post('/password-resets').send({ email: 'Reset.B@EXAMPLE.COM' }));
    });

    it('limits per email: another address is still accepted', async () => {
        for (let i = 0; i < 4; i++) {
            await api().post('/password-resets').send({ email: 'reset.c@example.com' });
        }

        expect((await api().post('/password-resets').send({ email: 'reset.d@example.com' })).status).toBe(202);
    });
});

describe('RATE_LIMIT_DISABLED=true', () => {
    it('turns every limiter off', async () => {
        process.env.RATE_LIMIT_DISABLED = 'true';
        try {
            for (let i = 0; i < 5; i++) {
                expect((await api().post('/password-resets').send({ email: 'reset.e@example.com' })).status).toBe(202);
            }
        } finally {
            process.env.RATE_LIMIT_DISABLED = 'false';
        }
    });
});
