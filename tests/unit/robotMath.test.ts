import { discountedFeeMinor } from '../../src/utils/deliveryFee';
import { deliveryEtaSeconds, robotVehicleFor } from '../../src/utils/deliveryEta';

// M9b: the robot price and time, pure functions.

describe('discountedFeeMinor', () => {
    it.each([
        [150, 50, 75],
        [230, 50, 115],
        [270, 30, 189],
        [190, 30, 133],   // 133.0
        [191, 50, 95],    // 95.5 → rounded DOWN: the half cent goes to the customer
        [199, 30, 139],   // 139.3
        [150, 0, 150],
        [150, 100, 0],
    ])('%i cents with %i%% off → %i', (fee, pct, expected) => {
        expect(discountedFeeMinor(fee, pct)).toBe(expected);
    });

    it('a bad setting can never raise the fee or make it negative', () => {
        expect(discountedFeeMinor(150, -20)).toBe(150);
        expect(discountedFeeMinor(150, 150)).toBe(0);
    });

    it('always whole cents', () => {
        for (let fee = 0; fee <= 400; fee++) {
            for (const pct of [30, 50]) {
                expect(Number.isInteger(discountedFeeMinor(fee, pct))).toBe(true);
            }
        }
    });
});

describe('deliveryEtaSeconds for robots', () => {
    it('a sidewalk robot walks 6 km/h on the road distance, whatever OSRM says for a car', () => {
        expect(deliveryEtaSeconds('robot', 180, 1_500)).toBe(900);
        expect(deliveryEtaSeconds('robot', 60, 1_500)).toBe(900);     // a fast road does not help it
        expect(deliveryEtaSeconds('robot', null, 2_000)).toBe(1_200); // no OSRM needed at all
    });

    it('a robot car takes 25% longer than a car', () => {
        expect(deliveryEtaSeconds('robot_car', 600, 4_200)).toBe(750);
        expect(deliveryEtaSeconds('robot_car', 101, 0)).toBe(126);    // 126.25
    });

    it('without OSRM the robot car uses the 25 km/h car fallback × 1.25', () => {
        expect(deliveryEtaSeconds('car', null, 2_500)).toBe(360);
        expect(deliveryEtaSeconds('robot_car', null, 2_500)).toBe(450);
    });
});

describe('robotVehicleFor', () => {
    it.each([
        [0, 'robot'],
        [1_999, 'robot'],
        [2_000, 'robot'],      // exactly the limit: still the sidewalk robot
        [2_001, 'robot_car'],
        [7_000, 'robot_car'],
    ])('%i m → %s', (distanceM, expected) => {
        expect(robotVehicleFor(distanceM, 2_000)).toBe(expected);
    });
});
