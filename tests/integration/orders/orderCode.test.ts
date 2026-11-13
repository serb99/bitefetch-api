import { generateOrderCode } from '../../../src/utils/orderCode';
import { mockRoute, checkout, readyCart, countOrders, getCart } from '../../helpers/customer';

// The code generator is replaced, so a test can force collisions with an existing order_code.
jest.mock('../../../src/utils/orderCode', () => ({ generateOrderCode: jest.fn() }));
const nextCode = jest.mocked(generateOrderCode);

const TOTAL = 1790;   // 2 x 800 + fee 190 (3001 m)

beforeEach(() => {
    mockRoute(3001);
    nextCode.mockReset();
});

describe('order_code collisions', () => {
    it('a code that is already taken is skipped and a new one is tried', async () => {
        nextCode.mockReturnValueOnce('BF-AAAAA');
        const first = await readyCart();
        expect((await checkout(first.customer, TOTAL)).body.orderCode).toBe('BF-AAAAA');

        nextCode.mockReturnValueOnce('BF-AAAAA').mockReturnValueOnce('BF-BBBBB');
        const second = await readyCart();
        const res = await checkout(second.customer, TOTAL);

        expect(res.status).toBe(201);
        expect(res.body.orderCode).toBe('BF-BBBBB');
        expect(nextCode).toHaveBeenCalledTimes(3);
    });

    it('after 5 taken codes it gives up with a 500, and saves nothing', async () => {
        nextCode.mockReturnValue('BF-AAAAA');
        const first = await readyCart();
        await checkout(first.customer, TOTAL);
        nextCode.mockClear();

        const second = await readyCart();
        const res = await checkout(second.customer, TOTAL);

        expect(res.status).toBe(500);
        expect(res.body.error.code).toBe('INTERNAL_ERROR');
        expect(nextCode).toHaveBeenCalledTimes(5);
        expect(await countOrders()).toBe(1);
        // the rollback also undid nothing to the cart: the second customer's cart is still full
        expect((await getCart(second.customer)).body.items).toHaveLength(1);
    });
});
