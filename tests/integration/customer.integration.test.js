require('dotenv').config();
const request = require('supertest');
const app = require('../../app');
const pool = require('../../database/pool');

describe('Customer API Integration Tests', () =>{
    let customerIds = [];

    beforeEach(async () => {
        const result = await pool.query(
            `INSERT INTO customers (first_name, last_name, email, phone, destination_address) VALUES
             ('Test', 'One', 'test.one@example.com', '0700000001', 'Test Address 1'),
             ('Test', 'Two', 'test.two@example.com', '0700000002', 'Test Address 2'),
             ('Test', 'Three', 'test.three@example.com', '0700000003', 'Test Address 3')
             RETURNING *`
        );
        customerIds = result.rows.map(row => row.id);
    })

    afterEach(async () => {
        await pool.query('DELETE FROM customers');
    })

    afterAll(async () => {
        await pool.end();
    })

    test('GET /customers returns 200 and an array', async () => {
        const response = await request(app).get('/customers');

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);
    })

    test('GET /customers/:id returns 200 and the correct customer', async () => {
        const response = await request(app).get(`/customers/${customerIds[0]}`);

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            id: customerIds[0],
            first_name: 'Test',
            last_name: 'One',
            email: 'test.one@example.com',
            phone: '0700000001',
            destination_address: 'Test Address 1'
        });
    })

    test('POST /customers creates a new customer and returns 201', async () =>{
        const response = await request(app).post('/customers').send({
            first_name: 'Test',
            last_name: 'Four',
            email: 'test.four@example.com',
            phone: '0700000004',
            destination_address: 'Test Address 4'
        });

        expect(response.status).toBe(201);
        expect(response.body.first_name).toBe('Test');
    })

    test('PATCH /customers/:id updates a customer and returns 200', async () => {
        const response = await request(app).patch(`/customers/${customerIds[2]}`).send({
            first_name: 'Test',
            last_name: 'Updated',
            email: 'test.update@example.com'
        });

        expect(response.status).toBe(200);
        expect(response.body.last_name).toBe('Updated');
    })

    test('DELETE /customers/:id deletes a customer and return 200', async () => {
        const response = await request(app).delete(`/customers/${customerIds[1]}`);

        expect(response.status).toBe(200);
        expect(response.body.id).toBe(customerIds[1]);
    })

    test('GET /customers/id returns 404 for non-existent customer', async () => {
        const response = await request(app).get('/customers/9999');

        expect(response.status).toBe(404);
        expect(response.body.error).toBe('Customer not found');
    })

    test('POST /customers returns 400 for missing required fields', async () => {
        const response = await request(app).post('/customers').send({
            first_name: 'Test',
            last_name: 'Five'
        });

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('Missing required fields');
    })

    test('PATCH /customers/:id returns 400 for no data provided', async () => {
        const response = await request(app).patch(`/customers/${customerIds[0]}`).send({});

        expect(response.status).toBe(400);
        expect(response.body.error).toBe('No data provided for update');
    })

    test('PATCH /customers/:id returns 404 for non-existent customer', async () => {
        const response = await request(app).patch('/customers/9999').send({
            first_name: 'Test',
            last_name: 'Updated',
            phone: '0700000005'
        });

        expect(response.status).toBe(404);
        expect(response.body.error).toBe('Customer not found');
    })
})