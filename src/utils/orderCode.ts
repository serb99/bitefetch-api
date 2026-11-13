import { randomInt } from 'node:crypto';

// 32 symbols: no 0/O and no 1/I, which are easy to confuse when read or typed
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

// 'BF-' + 5 symbols = 8 characters, the size of the orders.order_code
function generateOrderCode(): string {
    let code = '';
    for (let i = 0; i < 5; i++) {
        code += ALPHABET.charAt(randomInt(ALPHABET.length));
    }
    return `BF-${code}`;
}

export { generateOrderCode };