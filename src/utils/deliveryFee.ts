type FeeRules = {
    baseFeeMinor: number;       // delivery_fee_base_minor
    baseKm: number;             // delivery_fee_base_km
    perExtraKmMinor: number;    // delivery_fee_per_extra_km_minor
};

// Base fee up to baseKm; beyond that, every STARTED extra km adds perExtraKmMinor.
function deliveryFeeMinor(distanceM: number, rules: FeeRules): number {
    const extraM = Math.max(0, distanceM - rules.baseKm * 1000);
    const startedExtraKm = Math.ceil(extraM / 1000);
    return rules.baseFeeMinor + startedExtraKm * rules.perExtraKmMinor;
}

// The robot price: the human fee minus discountPct percent (robot_fee_discount_pct / robot_car_fee_discount_pct).
// Integer cents, rounded DOWN: a half cent always goes to the customer, never to us.
// The percentage is clamped to 0-100 so a bad setting can never make a negative or a higher fee.
function discountedFeeMinor(feeMinor: number, discountPct: number): number {
    const pct = Math.min(100, Math.max(0, discountPct));
    return Math.floor((feeMinor * (100 - pct)) / 100);
}

export { deliveryFeeMinor, discountedFeeMinor };
export type { FeeRules };
