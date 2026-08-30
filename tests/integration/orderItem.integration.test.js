require('dotenv').config();
const request = require('supertest');
const app = require('../../app');
const pool = require('../../database/pool');

describe('Order Item API Integration Tests', () => {
    let customerId;
    let orderId;
    let itemId;

    beforeEach(async () => {
        // 1. seed a customer
        const customerResult = await pool.query(
            `INSERT INTO customers (first_name, last_name, email, phone, destination_address)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            ['Test', 'Customer', 'test.customer@example.com', '0700000000', 'Test Address']
        );
        customerId = customerResult.rows[0].id;
        
        // 2. seed one order for that customer
        const orderResult = await pool.query(
            `INSERT INTO orders (customer_id, status, total) VALUES ($1, 'pending', 20.00) RETURNING *`,
            [customerId]
        );
        orderId = orderResult.rows[0].id;

        // 3. seed one item for that order
        const itemResult = await pool.query(
            `INSERT INTO order_items (order_id, item_name, unit_price, quantity)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [orderId, 'Test Item', 10.00, 2]
        );
        itemId = itemResult.rows[0].id;
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
        const response = await request(app).get(`/orders/${orderId}/items`);
        
        expect(response.status).toBe(200);
        expect(response.body[0]).toMatchObject({
            id: itemId,
            item_name: 'Test Item',
            order_id: orderId,
            quantity: 2,
            unit_price: '10'
        });
    });

    test('POST /orders/:orderId/items adds a new item and returns 201', async () => {
        const response = await request(app).post(`/orders/${orderId}/items`).send({
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
        const response = await request(app)
            .patch(`/orders/${orderId}/items/${itemId}`)
            .send({ quantity: 5 });

        expect(response.status).toBe(200);
        expect(response.body.quantity).toBe(5);
    });

    test('DELETE /orders/:orderId/items/:id deletes the item', async () => {
        const response = await request(app).delete(`/orders/${orderId}/items/${itemId}`);

        expect(response.status).toBe(200);
        expect(response.body.id).toBe(itemId);

        const check = await pool.query('SELECT * FROM order_items WHERE id = $1', [itemId]);
        expect(check.rows.length).toBe(0);
    });

    test('POST /orders/:orderId/items returns 400 when required fields are missing', async () => {
        const response = await request(app)
            .post(`/orders/${orderId}/items`)
            .send({ item_name: 'New Item' });

        expect(response.status).toBe(400);
    });

    test('POST /orders/:orderId/items returns 404 for a nonexistent order', async () => {
        const response = await request(app)
            .post('/orders/999999/items')
            .send({ item_name: 'New Item', unit_price: 5.50, quantity: 3 });

        expect(response.status).toBe(404);
    });

    test('PATCH /orders/:orderId/items/:id returns 400 when quantity is missing', async () => {
        const response = await request(app)
            .patch(`/orders/${orderId}/items/${itemId}`)
            .send({});

        expect(response.status).toBe(400);
    });

    test('PATCH /orders/:orderId/items/:id returns 400 when quantity is not positive', async () => {
        const response = await request(app)
            .patch(`/orders/${orderId}/items/${itemId}`)
            .send({ quantity: -1 });

        expect(response.status).toBe(400);
    });

    test('PATCH /orders/:orderId/items/:id returns 404 for a nonexistent item', async () => {
        const response = await request(app)
            .patch(`/orders/${orderId}/items/999999`)
            .send({ quantity: 5 });

        expect(response.status).toBe(404);
    });

    test('DELETE /orders/:orderId/items/:id returns 404 for a nonexistent item', async () => {
        const response = await request(app).delete(`/orders/${orderId}/items/999999`);

        expect(response.status).toBe(404);
    });
})