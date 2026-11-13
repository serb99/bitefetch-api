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

export { deliveryFeeMinor };
export type { FeeRules };