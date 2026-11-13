import { deliveryFeeMinor } from '../../src/utils/deliveryFee';
import { generateOrderCode } from '../../src/utils/orderCode';

// The platform defaults: 150 cents up to 3 km, then 40 cents per STARTED extra km.
const RULES = { baseFeeMinor: 150, baseKm: 3, perExtraKmMinor: 40 };

describe('deliveryFeeMinor', () => {
    it.each([
        [0, 150],
        [2500, 150],
        [3000, 150],    // exactly the base distance: no extra km
        [3001, 190],    // one metre over starts the first extra km
        [4000, 190],
        [4200, 230],    // 1.2 extra km = 2 started km
        [7000, 310],    // the maximum delivery distance: 4 extra km
    ])('%i m costs %i cents', (distanceM, expected) => {
        expect(deliveryFeeMinor(distanceM, RULES)).toBe(expected);
    });
});

describe('generateOrderCode', () => {
    it('is BF- plus 5 symbols without the look-alikes 0, O, 1 and I', () => {
        for (let i = 0; i < 200; i++) {
            expect(generateOrderCode()).toMatch(/^BF-[A-HJ-NP-Z2-9]{5}$/);
        }
    });
});
