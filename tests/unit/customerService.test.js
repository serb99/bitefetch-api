const customerService = require('../../src/services/customerService');
const pool = require('../../src/database/pool');

jest.mock('../../src/database/pool');

describe('updateCustomer service unit tests', () => {
  test('Assert the update query is build correctly for a single-field update', async () => {
    pool.query.mockResolvedValue({rows: [{ id: 1, phone: '0799999999'}]});

    await customerService.updateCustomer('1', { phone: '0799999999' });

    expect(pool.query).toHaveBeenCalledWith(
        'UPDATE customers SET phone = $1 WHERE id = $2 RETURNING *',
        ['0799999999', '1']
    );
  })

  test('builds correct SQL and values for a multi-field update', async () => {
    pool.query.mockResolvedValue({rows: [{id: 1}]});

    await customerService.updateCustomer('1', { phone: '0799999999', email: 'new@example.com' });

    expect(pool.query).toHaveBeenCalledWith(
        'UPDATE customers SET phone = $1, email = $2 WHERE id = $3 RETURNING *',
        ['0799999999', 'new@example.com', '1']);
  })

  test('error is thrown when something goes wrong in DB', async() => {
    const dbError = new Error('Database error');
    pool.query.mockRejectedValue(dbError);

    const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    
    await expect(customerService.updateCustomer('1', { phone: '0799999999' }))
        .rejects.toThrow('Database error');
     expect(consoleErrorSpy).toHaveBeenCalledWith('Error updating customer:', dbError);

     consoleErrorSpy.mockRestore();
  })
})