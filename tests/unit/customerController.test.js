const customerService = require('../../services/customerService');
const customerController = require('../../controllers/customerController');

jest.mock('../../services/customerService');

function createMockRes(){
    return {
        status: jest.fn().mockReturnThis(),
        json: jest.fn()
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('customerController.getCustomerById', () => {

    test('should return 200 and the customer data when customer exists', async () => {
        const fakeCustomer = { id : 1, first_name: 'Test', email: 'test@example.com' };
        customerService.getCustomerById.mockResolvedValue(fakeCustomer);

        const req = { params: { id: '1' } };
        const res = createMockRes();

        await customerController.getCustomerById(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(fakeCustomer);
    })

    test('should return 404 when customer does not exist', async () => {
        const fakeCustomer = null;
        customerService.getCustomerById.mockResolvedValue(fakeCustomer);

        const req = { params: { id: '9999' } };
        const res = createMockRes();

        await customerController.getCustomerById(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({ error: 'Customer not found' });
    })

    test('should return 500 when service throws an error', async () => {
        customerService.getCustomerById.mockRejectedValue(new Error('Database error'));

        const req = { params: { id: '1' } };
        const res = createMockRes();

        await customerController.getCustomerById(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'Internal Server Error' });
    })
})

describe('customerController.createCustomer', ()  => {
    test('should return 201 when a new customer is inserted', async () => {
        const newCustomerInput = {
            first_name: 'Test',
            last_name: 'User',
            email: 'test.user@example.com',
            phone: '0700000000',
            destination_address: 'Test Address 1'
        };

        const createdCustomer = {
            id: 1,
            ...newCustomerInput,
            created_at: new Date().toISOString()
        };

        customerService.createCustomer.mockResolvedValue(createdCustomer);

        const req = { body: newCustomerInput };
        const res = createMockRes();

        await customerController.createCustomer(req, res);

        expect(res.status).toHaveBeenCalledWith(201);
        expect(res.json).toHaveBeenCalledWith(createdCustomer);
    })

    test('should return 400 when missing required fields', async() => {
        const newCustomerInput = {
            last_name: 'User',
            phone: '0700000000',
            destination_address: 'Test Address 1'
        };

        customerService.createCustomer.mockRejectedValue(new Error("Field constraint not null"));

        const req = { body: newCustomerInput };
        const res = createMockRes();

        await customerController.createCustomer(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'Missing required fields' });
    })

    test('should return 500 when service throws an error', async () => {
        const newCustomerInput = {
            first_name: 'Test',
            last_name: 'User',
            email: 'test.user@example.com',
            phone: '0700000000',
            destination_address: 'Test Address 1'
        };

        customerService.createCustomer.mockRejectedValue(new Error('Database error'));

        const req = { body: newCustomerInput };
        const res = createMockRes();

        await customerController.createCustomer(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'Internal Server Error' });
    })
})

describe('customerController.updateCustomer', () => {

    test('should return 200 and the updated customer when found', async () => {
        const updatedCustomer = {
            id: 1,
            first_name: 'Test',
            last_name: 'User',
            email: 'test.user@example.com',
            phone: '0799999999',
            destination_address: 'Test Address 1',
            created_at: new Date().toISOString()
        };

        customerService.updateCustomer.mockResolvedValue(updatedCustomer);

        const req = { params: { id: '1' }, body: { phone: '0799999999' } };
        const res = createMockRes();

        await customerController.updateCustomer(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(updatedCustomer);
    });

    test('should return 400 when no data is provided', async () => {
        const req = { params: { id: '1' }, body: {} };
        const res = createMockRes();

        await customerController.updateCustomer(req, res);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(res.json).toHaveBeenCalledWith({ error: 'No data provided for update' });
        expect(customerService.updateCustomer).not.toHaveBeenCalled();
    });

    test('should return 404 when customer does not exist', async () => {
        customerService.updateCustomer.mockResolvedValue(undefined);

        const req = { params: { id: '9999' }, body: { phone: '0799999999' } };
        const res = createMockRes();

        await customerController.updateCustomer(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({ error: 'Customer not found' });
    });

    test('should return 500 when service throws an error', async () => {
        customerService.updateCustomer.mockRejectedValue(new Error('Database error'));

        const req = { params: { id: '1' }, body: { phone: '0799999999' } };
        const res = createMockRes();

        await customerController.updateCustomer(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'Internal Server Error' });
    });
});

describe('customerController.deleteCustomer', () => {
    test('should return 200 when succesfully deleted a customer', async () => {
        const idDeletedCustomer = '1';

        customerService.deleteCustomer.mockResolvedValue(idDeletedCustomer);

        const req = {params: {id: '1'}};
        const res = createMockRes();

        await customerController.deleteCustomer(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.json).toHaveBeenCalledWith(idDeletedCustomer);
    })

    test('should return 404 when customer does not exist', async () => {
        customerService.deleteCustomer.mockResolvedValue(undefined);

        const req = { params: { id: '9999' } };
        const res = createMockRes();

        await customerController.deleteCustomer(req, res);

        expect(res.status).toHaveBeenCalledWith(404);
        expect(res.json).toHaveBeenCalledWith({ error: 'Customer not found' });
    });

    test('should return 500 when service throws an error', async () => {
        customerService.deleteCustomer.mockRejectedValue(new Error('Database error'));

        const req = { params: { id: '1' }};
        const res = createMockRes();

        await customerController.deleteCustomer(req, res);

        expect(res.status).toHaveBeenCalledWith(500);
        expect(res.json).toHaveBeenCalledWith({ error: 'Internal Server Error' });
    });

    test('should return 409 when customer has existing orders', async() => {
        const fkError = new Error('violates foreign key constraint');
        fkError.code = '23503';
        customerService.deleteCustomer.mockRejectedValue(fkError);

        const req = { params: { id: '1' }};
        const res = createMockRes();

        await customerController.deleteCustomer(req, res);
        
        expect(res.status).toHaveBeenCalledWith(409);
        expect(res.json).toHaveBeenCalledWith({ error: 'Cannot delete customer with existing orders' });
    })
})