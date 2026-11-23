import { distanceMeters } from '../../src/utils/geo';
import { deliveryEtaSeconds } from '../../src/utils/deliveryEta';
import { courierPositionSchema, declineOfferSchema } from '../../src/schemas/courierSchema';

// M7 pure helpers: the haversine distance, the delivery ETA per vehicle and the position body rules.

// One degree of a great circle on a sphere of radius 6 371 km.
const ONE_DEGREE_M = (6_371_000 * Math.PI) / 180; // 111 194.93 m

describe('distanceMeters', () => {
    it('is 0 for the same point', () => {
        expect(distanceMeters({ lat: 46.7712, lng: 23.5918 }, { lat: 46.7712, lng: 23.5918 })).toBe(0);
    });

    it('one degree along a meridian and along the equator is one great-circle degree', () => {
        expect(distanceMeters({ lat: 46, lng: 23 }, { lat: 47, lng: 23 })).toBeCloseTo(ONE_DEGREE_M, 3);
        expect(distanceMeters({ lat: 0, lng: 10 }, { lat: 0, lng: 11 })).toBeCloseTo(ONE_DEGREE_M, 3);
    });

    it('a degree of longitude shrinks with cos(latitude) (Cluj, ~46.77°N)', () => {
        const east = distanceMeters({ lat: 46.77, lng: 23 }, { lat: 46.77, lng: 23.001 });
        expect(east).toBeCloseTo(0.001 * ONE_DEGREE_M * Math.cos((46.77 * Math.PI) / 180), 1);
    });

    it('is symmetric', () => {
        const a = { lat: 46.7712, lng: 23.5918 };
        const b = { lat: 46.76, lng: 23.576 };
        expect(distanceMeters(a, b)).toBeCloseTo(distanceMeters(b, a), 9);
    });
});

describe('deliveryEtaSeconds', () => {
    it.each([
        ['bike', 900],
        ['scooter', 720],
        ['car', 600],
    ] as const)('%s: the OSRM car duration (600 s) times the vehicle factor = %d s', (vehicle, expected) => {
        expect(deliveryEtaSeconds(vehicle, 600, 3_000)).toBe(expected);
    });

    it('without OSRM: the road distance at 25 km/h, times the factor', () => {
        // 2 500 m at 25 km/h = 360 s
        expect(deliveryEtaSeconds('car', null, 2_500)).toBe(360);
        expect(deliveryEtaSeconds('bike', null, 2_500)).toBe(540);
    });

    it('rounds to whole seconds', () => {
        expect(deliveryEtaSeconds('scooter', 101, 0)).toBe(121); // 121.2
    });
});

describe('courierPositionSchema', () => {
    const base = { lat: 46.77, lng: 23.59, recordedAt: '2026-11-23T10:00:00+02:00' };

    it('turns recordedAt into a Date (offset or Z)', () => {
        const parsed = courierPositionSchema.parse(base);
        expect(parsed.recordedAt).toEqual(new Date('2026-11-23T08:00:00Z'));
        expect(courierPositionSchema.parse({ ...base, recordedAt: '2026-11-23T08:00:00Z' }).recordedAt).toEqual(parsed.recordedAt);
    });

    it('rounds accuracy and heading; 360 and 359.6 become 0 (north)', () => {
        expect(courierPositionSchema.parse({ ...base, accuracyM: 12.4 }).accuracyM).toBe(12);
        expect(courierPositionSchema.parse({ ...base, headingDeg: 360 }).headingDeg).toBe(0);
        expect(courierPositionSchema.parse({ ...base, headingDeg: 359.6 }).headingDeg).toBe(0);
        expect(courierPositionSchema.parse({ ...base, headingDeg: 90.4 }).headingDeg).toBe(90);
    });

    it('the optional fields may be null or absent', () => {
        expect(courierPositionSchema.safeParse({ ...base, accuracyM: null, headingDeg: null, speedMps: null }).success).toBe(true);
        expect(courierPositionSchema.safeParse(base).success).toBe(true);
    });

    it.each([
        ['heading below 0', { headingDeg: -10 }],
        ['heading above 360', { headingDeg: 361 }],
        ['speed above 100', { speedMps: 100.1 }],
        ['a negative accuracy', { accuracyM: -1 }],
        ['a date without offset', { recordedAt: '2026-11-23T10:00:00' }],
        ['a date only', { recordedAt: '2026-11-23' }],
        ['an extra field', { battery: 80 }],
    ])('rejects %s', (_name, change) => {
        expect(courierPositionSchema.safeParse({ ...base, ...change }).success).toBe(false);
    });
});

describe('declineOfferSchema', () => {
    it('no body means no reason', () => {
        expect(declineOfferSchema.parse(undefined)).toEqual({});
    });

    it('went_offline is for the server only, not for the courier', () => {
        expect(declineOfferSchema.safeParse({ reason: 'went_offline' }).success).toBe(false);
    });
});
