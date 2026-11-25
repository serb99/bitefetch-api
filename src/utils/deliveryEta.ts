type VehicleType = 'bike' | 'scooter' | 'car' | 'robot' | 'robot_car';
type RobotVehicle = Extract<VehicleType, 'robot' | 'robot_car'>;

// OSRM answers for a car. robot_car drives carefully: 25% slower than a car on the same route.
const CAR_FACTOR: Record<Exclude<VehicleType, 'robot'>, number> = { bike: 1.5, scooter: 1.2, car: 1.0, robot_car: 1.25 };
// Without OSRM: a car in the city does about 25 km/h
const FALLBACK_CAR_MPS = 25_000 / 3600;
// A sidewalk robot walks at about 6 km/h whatever the traffic, so its time comes from the distance, not from OSRM
const SIDEWALK_ROBOT_MPS = 6_000 / 3600;

// Seconds from the restaurant to the customer. carDurationS null: OSRM did not answer.
function deliveryEtaSeconds(vehicle: VehicleType, carDurationS: number | null, roadDistanceM: number): number {
    if (vehicle === 'robot') {
        return Math.round(roadDistanceM / SIDEWALK_ROBOT_MPS);
    }
    const carSeconds = carDurationS ?? roadDistanceM / FALLBACK_CAR_MPS;
    return Math.round(carSeconds * CAR_FACTOR[vehicle]);
}

// Which robot delivers a route: a sidewalk robot up to maxSidewalkM (robot_max_distance_m), a robot car beyond.
function robotVehicleFor(roadDistanceM: number, maxSidewalkM: number): RobotVehicle {
    return roadDistanceM <= maxSidewalkM ? 'robot' : 'robot_car';
}

export { deliveryEtaSeconds, robotVehicleFor };
export type { VehicleType, RobotVehicle };
