require('dotenv').config();
const request = require('supertest');
const app = require('../../app');
const pool = require('../../database/pool');

afterAll(async () => {
    await pool.end();
})

describe('Customer API Integration Tests - Create Customer (no auth required)', () => {
    afterEach(async () => {
        await pool.query('DELETE FROM customers');
    })

    test('POST /customers creates a new customer and returns 201', async () =>{
        const response = await request(app).post('/customers').send({
            first_name: 'Test',
            last_name: 'Four',
            email: 'test.four@example.com',
            phone: '0700000004',
            destination_address: 'Test Address 4',
            password: 'Pass123'
        });

        expect(response.status).toBe(201);
        expect(response.body.first_name).toBe('Test');
    })

    test('POST /customers returns 400 for missing required fields', async () => {
        const response = await request(app).post('/customers').send({
            first_name: 'Test',
            last_name: 'Five'
        });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('Missing required fields');
    })
})

describe('Customer API Integration Tests', () =>{
    let customerId;
    let agent;

    beforeEach(async () => {
        agent = request.agent(app);

        const result = await agent.post('/customers').send({ 
            first_name: 'Test', 
            last_name: 'Customer', 
            email: 'test.one@example.com', 
            phone: '0700000001', 
            destination_address: 'Test Address 1', 
            password: 'Pass123' }
        );

        customerId = result.body.id;

        await agent.post('/auth/login').send({
            email: 'test.one@example.com',
            password: 'Pass123'
        });
    })

    afterEach(async () => {
        await pool.query('DELETE FROM customers');
    })

    test('GET /customers returns 200 and an array', async () => {
        const response = await agent.get('/customers');

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);
    })

    test('GET /customers/:id returns 200 and the correct customer', async () => {
        const response = await agent.get(`/customers/${customerId}`);

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            id: customerId,
            first_name: 'Test',
            last_name: 'Customer',
            email: 'test.one@example.com',
            phone: '0700000001',
            destination_address: 'Test Address 1'
        });
    })

    test('PATCH /customers/:id updates a customer and returns 200', async () => {
        const response = await agent.patch(`/customers/${customerId}`).send({
            first_name: 'Test',
            last_name: 'Updated',
            email: 'test.update@example.com'
        });

        expect(response.status).toBe(200);
        expect(response.body.last_name).toBe('Updated');
    })

    test('DELETE /customers/:id deletes a customer and return 200', async () => {
        const response = await agent.delete(`/customers/${customerId}`);

        expect(response.status).toBe(200);
        expect(response.body.id).toBe(customerId);
    })

    test('GET /customers/id returns 404 for non-existent customer', async () => {
        const response = await agent.get('/customers/9999');

        expect(response.status).toBe(404);
        expect(response.body.error).toBe('Customer not found');
    })

    test('PATCH /customers/:id returns 400 for no data provided', async () => {
        const response = await agent.patch(`/customers/${customerId}`).send({});

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('No data provided for update');
    })

    test('PATCH /customers/:id returns 404 for non-existent customer', async () => {
        const response = await agent.patch('/customers/9999').send({
            first_name: 'Test',
            last_name: 'Updated',
            phone: '0700000005'
        });

        expect(response.status).toBe(404);
        expect(response.body.error).toBe('Customer not found');
    })
})
