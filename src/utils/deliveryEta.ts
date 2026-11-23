type VehicleType = 'bike' | 'scooter' | 'car';

// OSRM answers for a car
const VEHICLE_FACTOR: Record<VehicleType, number> = { bike: 1.5, scooter: 1.2, car: 1.0 };
// Without OSRM: a car in the city does about 25 km/h
const FALLBACK_CAR_MPS = 25_000 / 3600;

// Seconds from the restaurant to the customer. carDurationS null: OSRM did not answer.
function deliveryEtaSeconds(vehicle: VehicleType, carDurationS: number | null, roadDistanceM: number): number {
    const carSeconds = carDurationS ?? roadDistanceM / FALLBACK_CAR_MPS;
    return Math.round(carSeconds * VEHICLE_FACTOR[vehicle]);
}

export { deliveryEtaSeconds };
export type { VehicleType };