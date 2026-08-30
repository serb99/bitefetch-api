require('dotenv').config();
const request = require('supertest');
const app = require('../../app');
const pool = require('../../database/pool');

describe('Order API Integration Tests', () => {
    let customerId;
    let orderIds = [];

    beforeEach(async () => {
        //1. seed a customer first, since orders need a valid customer id
        const customerResult = await pool.query(
            `INSERT INTO customers (first_name, last_name, email, phone, destination_address)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
             ['Test', 'Customer', 'test.customer@example.com', '0700000000', 'Test Address']
        );
        customerId = customerResult.rows[0].id;

        //2. seed a few orders for that customer
        const ordersResult = await pool.query(
            `INSERT INTO orders (customer_id, status, total) VALUES
            ($1, 'pending', 20.00),
            ($1, 'preparing', 35.50),
            ($1, 'delivered', 12.00)
            RETURNING *`,
            [customerId]
        );
        orderIds = ordersResult.rows.map(row => row.id);
        
        //3. seed order_items for each order
        for (const orderId of orderIds){
            await pool.query(
                `INSERT INTO order_items (order_id, item_name, unit_price, quantity)
                 VALUES ($1, $2, $3, $4)`,
                [orderId, 'Test Item', 10.00, 1]
            );
        }
    });

    afterEach(async() => {
        await pool.query('DELETE FROM order_items');
        await pool.query('DELETE FROM orders');
        await pool.query('DELETE FROM customers');
    });

    afterAll(async () => {
        await pool.end();
    });

    test('GET /orders returns and an array', async () => {
        const response = await request(app).get('/orders');

        expect(response.status).toBe(200);
        expect(Array.isArray(response.body)).toBe(true);
    })

    test('GET /orders/:id returns 200 and the correct order', async() =>{
        const response = await request(app).get(`/orders/${orderIds[0]}`);
        
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
            customer_id: customerId,
            status: 'pending',
            total: '20.00'
        });
    })

    test('POST /orders creates a new order with order items and returns 201', async() => {
        const response = await request(app).post('/orders').send({
            customer_id: customerId,
            items: [{
              item_name: 'test_item',
              unit_price: '11.10',
              quantity: '2'
            }]
        });

        expect(response.status).toBe(201);
        expect(response.body.customer_id).toBe(customerId);
        expect(response.body.status).toBe('pending');
        expect(response.body.total).toBe('22.2');
    })

    test('PATCH /orders/:id updates the status',async () => {
        const response = await request(app)
            .patch(`/orders/${orderIds[0]}`)
            .send({status: 'preparing'});

        expect(response.status).toBe(200);
        expect(response.body.status).toBe('preparing');
        expect(response.body.delivered_at).toBeNull();
    })

    test('PATCH /orders/:id sets delivered_at automatically when status becomes delivered', async () => {
        const response = await request(app)
            .patch(`/orders/${orderIds[0]}`)
            .send({ status: 'delivered' });

        expect(response.status).toBe(200);
        expect(response.body.status).toBe('delivered');
        expect(response.body.delivered_at).not.toBeNull();
    })

    test('PATCH /orders/:id returns 400 when no data is provided', async () => {
        const response = await request(app)
            .patch(`/orders/${orderIds[0]}`)
            .send({});

        expect(response.status).toBe(400);
    });

    test('PATCH /orders/:id returns 404 for a nonexistent order', async () => {
        const response = await request(app)
            .patch('/orders/999999')
            .send({ status: 'preparing' });

        expect(response.status).toBe(404);
    });

    test('DELETE /orders/:id deletes the order and its items', async () => {
        const response = await request(app).delete(`/orders/${orderIds[0]}`);

        expect(response.status).toBe(200);
        expect(response.body.id).toBe(orderIds[0]);

        const orderCheck = await pool.query('SELECT * FROM orders WHERE id = $1', [orderIds[0]]);
        expect(orderCheck.rows.length).toBe(0);

        const itemsCheck = await pool.query('SELECT * FROM order_items WHERE order_id = $1', [orderIds[0]]);
        expect(itemsCheck.rows.length).toBe(0);
    });

    test('DELETE /orders/:id returns 404 for a nonexistent order', async () => {
        const response = await request(app).delete('/orders/999999');

        expect(response.status).toBe(404);
    });

    test('GET /orders/:id returns 404 for a nonexistent order', async () => {
        const response = await request(app).get('/orders/999999');

        expect(response.status).toBe(404);
    });

    test('POST /orders returns 400 when customer_id is missing', async () => {
        const response = await request(app).post('/orders').send({
            items: [{ item_name: 'test_item', unit_price: '11.10', quantity: '2' }]
        });

        expect(response.status).toBe(400);
    });

    test('POST /orders returns 400 when items array is missing', async () => {
        const response = await request(app).post('/orders').send({
            customer_id: customerId
        });

        expect(response.status).toBe(400);
    });

    test('POST /orders returns 400 when an item is missing a required field', async () => {
        const response = await request(app).post('/orders').send({
            customer_id: customerId,
            items: [{ item_name: 'test_item', unit_price: '11.10' }]  // missing quantity
        });

        expect(response.status).toBe(400);
    });
})