import { AppError } from '../errors/AppError';
import { getRoute } from './routeService';
import { getNumberSettings } from './settingsService';
import { deliveryFeeMinor, discountedFeeMinor } from '../utils/deliveryFee';
import { deliveryEtaSeconds, robotVehicleFor, type RobotVehicle } from '../utils/deliveryEta';
import type { Point } from './osrmClient';

// The human courier quote (unchanged since M4: the cart's `delivery` and the checkout fee)
type DeliveryQuote = { distanceM: number; durationS: number; feeMinor: number };

// The robot quote. etaS: the robot's own time (a sidewalk robot is much slower than the car durationS)
type RobotQuote = { vehicle: RobotVehicle; distanceM: number; feeMinor: number; etaS: number };

type DeliveryOptions = { human: DeliveryQuote; robot: RobotQuote | null };

// Robots deliver only with a Stripe TEST key: a robot "delivery" with a live key would capture a real card.
// Read at call time (not at import) so a test can switch it.
function robotsEnabled(): boolean {
    return (process.env.STRIPE_SECRET_KEY ?? '').startsWith('sk_test_');
}

// Both prices from ONE route lookup: the robot uses the same road distance as the human courier.
async function quoteDeliveryOptions(restaurant: Point, address: Point): Promise<DeliveryOptions> {
    const route = await getRoute(restaurant, address);

    const s = await getNumberSettings([
        'delivery_fee_base_minor',
        'delivery_fee_base_km',
        'delivery_fee_per_extra_km_minor',
        'max_delivery_distance_m',
        'robot_max_distance_m',
        'robot_fee_discount_pct',
        'robot_car_fee_discount_pct',
    ] as const);

    // The same limit for both modes: a robot car does not go farther than a human courier
    if (route.distanceM > s.max_delivery_distance_m) {
        throw new AppError(422, 'ADDRESS_OUT_OF_RANGE', 'This restaurant does not deliver that far', {
            maxDistanceM: s.max_delivery_distance_m,
        });
    }

    const humanFee = deliveryFeeMinor(route.distanceM, {
        baseFeeMinor: s.delivery_fee_base_minor,
        baseKm: s.delivery_fee_base_km,
        perExtraKmMinor: s.delivery_fee_per_extra_km_minor,
    });
    const human: DeliveryQuote = { distanceM: route.distanceM, durationS: route.durationS, feeMinor: humanFee };

    if (!robotsEnabled()) {
        return { human, robot: null };
    }

    const vehicle = robotVehicleFor(route.distanceM, s.robot_max_distance_m);
    const discountPct = vehicle === 'robot' ? s.robot_fee_discount_pct : s.robot_car_fee_discount_pct;
    return {
        human,
        robot: {
            vehicle,
            distanceM: route.distanceM,
            feeMinor: discountedFeeMinor(humanFee, discountPct),
            etaS: deliveryEtaSeconds(vehicle, route.durationS, route.distanceM),
        },
    };
}

export { quoteDeliveryOptions, robotsEnabled };
export type { DeliveryQuote, RobotQuote, DeliveryOptions };
