const pool = require('../../database/pool');
const orderService = require('../../services/orderService');

jest.mock('../../database/pool');

describe('orderService.updateOrder', () => {
    test('sets delivered_at when status is delivered', async () =>{
        pool.query.mockResolvedValue({rows: [{id: 1, status: 'delivered'}]});

        await orderService.updateOrder('1', 'delivered');

        expect(pool.query).toHaveBeenCalledWith(
            'UPDATE orders SET status = $1, delivered_at = NOW() WHERE id = $2 RETURNING *',
            ['delivered', '1']
        );
    });

    test('does not set delivered_at for other statuses', async() =>{
        pool.query.mockResolvedValue({rows: [{id: 1, status: 'preparing'}]});

        await orderService.updateOrder('1', 'preparing');

        expect(pool.query).toHaveBeenCalledWith(
            'UPDATE orders SET status = $1 WHERE id = $2 RETURNING *', 
            ['preparing', '1']
        );
    })
});