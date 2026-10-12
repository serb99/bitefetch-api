require('dotenv').config();
const request = require('supertest');
const app = require('../../src/app');
const pool = require('../../src/database/pool');

describe('Order Item API Integration Tests', () => {
    let customerId;
    let orderId;
    let itemId;
    let agent;

    beforeEach(async () => {
        agent = request.agent(app); // Create a new agent for each test to maintain session state
        // 1. seed a customer
        const customerResult = await agent.post('/customers').send({
            first_name: 'Test',
            last_name: 'Customer',
            email: 'test.customer@example.com',
            phone: '0700000000',
            destination_address: 'Test Address',
            password: 'TestPass123'
        });
        customerId = customerResult.body.id;

        await agent.post('/auth/login').send({
            email: 'test.customer@example.com',
            password: 'TestPass123'
        });

        // 2. seed one order for that customer
        const orderResult = await agent.post('/orders').send({
            customer_id: customerId,
            items: [{
                item_name: 'Item1',
                unit_price: 8.00,
                quantity: 1
            }],
        });
        orderId = orderResult.body.id;

        //3. seed one more item for that order
        const itemResult = await agent.post(`/orders/${orderId}/items`).send({
            item_name: 'Item2',
            unit_price: 10.00,
            quantity: 2
        });
        itemId = itemResult.body.id;
    });

    afterEach(async () => {
        await pool.query('DELETE FROM order_items');
        await pool.query('DELETE FROM orders');
        await pool.query('DELETE FROM customers');
    });

    afterAll(async () => {
        await pool.end();
    });

    test('GET /item returns 200 and an array', async () => {
        const response = await agent.get(`/orders/${orderId}/items`);
        
        expect(response.status).toBe(200);
        expect(response.body).toHaveLength(2);
        expect(response.body[0]).toMatchObject({
            item_name: 'Item1',
            order_id: orderId,
            quantity: 1,
            unit_price: '8'
        });
    });

    test('POST /orders/:orderId/items adds a new item and returns 201', async () => {
        const response = await agent.post(`/orders/${orderId}/items`).send({
            orderId: orderId,
            item_name: 'New Item', 
            unit_price: 5.50, 
            quantity: 3 
        });

        expect(response.status).toBe(201);
        expect(response.body).toMatchObject({
            order_id: orderId,
            item_name: 'New Item',
            quantity: 3
        });
    });

    test('PATCH /orders/:orderId/items/:id updates the quantity', async () => {
        const response = await agent.patch(`/orders/${orderId}/items/${itemId}`).send({ quantity: 5 });

        expect(response.status).toBe(200);
        expect(response.body.quantity).toBe(5);
    });

    test('DELETE /orders/:orderId/items/:id deletes the item', async () => {
        const response = await agent.delete(`/orders/${orderId}/items/${itemId}`);

        expect(response.status).toBe(200);
        expect(response.body.id).toBe(itemId);

        const check = await pool.query('SELECT * FROM order_items WHERE id = $1', [itemId]);
        expect(check.rows.length).toBe(0);
    });

    test('POST /orders/:orderId/items returns 400 when required fields are missing', async () => {
        const response = await agent.post(`/orders/${orderId}/items`).send({ item_name: 'New Item' });

        expect(response.status).toBe(400);
    });

    test('POST /orders/:orderId/items returns 404 for a nonexistent order', async () => {
        const response = await agent.post('/orders/999999/items').send({ item_name: 'New Item', unit_price: 5.50, quantity: 3 });

        expect(response.status).toBe(404);
    });

    test('PATCH /orders/:orderId/items/:id returns 400 when quantity is missing', async () => {
        const response = await agent.patch(`/orders/${orderId}/items/${itemId}`).send({});

        expect(response.status).toBe(400);
    });

    test('PATCH /orders/:orderId/items/:id returns 400 when quantity is not positive', async () => {
        const response = await agent.patch(`/orders/${orderId}/items/${itemId}`).send({ quantity: -1 });

        expect(response.status).toBe(400);
    });

    test('PATCH /orders/:orderId/items/:id returns 404 for a nonexistent item', async () => {
        const response = await agent.patch(`/orders/${orderId}/items/999999`).send({ quantity: 5 });

        expect(response.status).toBe(404);
    });

    test('DELETE /orders/:orderId/items/:id returns 404 for a nonexistent item', async () => {
        const response = await agent.delete(`/orders/${orderId}/items/999999`);

        expect(response.status).toBe(404);
    });
})