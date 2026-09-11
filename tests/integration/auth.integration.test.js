require('dotenv').config();
const request = require('supertest');
const app = require('../../app');
const pool = require('../../database/pool');

describe('Auth Integration Tests', () => {
    const testEmail = 'auth.test@example.com';
    const testPassword = 'MySecret123';

    afterEach(async () => {
        await pool.query('DELETE FROM customers WHERE email = $1', [testEmail]);
    });

    afterAll(async () =>{
        await pool.end();
    });

    test('signup, login, and accessing a protected route succeeds', async () =>{
        const agent = request.agent(app);

        await agent.post('/customers').send({
            first_name: 'Auth', 
            last_name: 'Test',
            email: testEmail,
            phone: '0700000000',
            destination_address: 'Test address',
            password: testPassword
        });

        const loginRes = await agent.post('/auth/login').send({
            email: testEmail,
            password: testPassword
        });
        expect(loginRes.status).toBe(200);

        const protectedRes = await agent.get('/orders');
        expect(protectedRes.status).toBe(200);
    });

    test('login with wrong password returns 401 with a generic message', async () => {
        await request(app).post('/customers').send({
            first_name: 'Auth', 
            last_name: 'Test', 
            email: testEmail,
            phone: '0700000000', 
            destination_address: 'Test Address',
            password: testPassword
        });

        const res = await request(app).post('/auth/login').send({ email: testEmail, password: 'WrongPassword' });
        
        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: 'Invalid email or password' });
    })

    test('login with nonexistent email returns the same 401 message', async () => {
        const res = await request(app).post('/auth/login').send({ email: 'nobody@example.com', password: 'whatever' });

        expect(res.status).toBe(401);
        expect(res.body).toEqual({ error: 'Invalid email or password' });
    });

    test('accessing a protected route with no session returns 401', async () => {
        const res = await request(app).get('/orders');
        expect(res.status).toBe(401);
    });

    test('logout destroys the session, old cookie no longer works', async () => {
        const agent = request.agent(app);

        await agent.post('/customers').send({
            first_name: 'Auth', last_name: 'Test', email: testEmail,
            phone: '0700000000', destination_address: 'Test Address', password: testPassword
        });
        await agent.post('/auth/login').send({ email: testEmail, password: testPassword });
        const logoutRes = await agent.post('/auth/logout');
        
        expect(logoutRes.status).toBe(200);

        const afterLogoutRes = await agent.get('/orders');
        expect(afterLogoutRes.status).toBe(401);
    });
})