import { AppError } from '../errors/AppError';
import { getRoute } from './routeService';
import { getNumberSettings } from './settingsService';
import { deliveryFeeMinor } from '../utils/deliveryFee';
import type { Point } from './osrmClient';

type DeliveryQuote = { distanceM: number; durationS: number; feeMinor: number };

// Distance by road from the restaurant to the address, checked against the limit, with the fee.
async function quoteDelivery(restaurant: Point, address: Point): Promise<DeliveryQuote> {
    const route = await getRoute(restaurant, address);

    const s = await getNumberSettings([
        'delivery_fee_base_minor',
        'delivery_fee_base_km',
        'delivery_fee_per_extra_km_minor',
        'max_delivery_distance_m',
    ] as const);

    if (route.distanceM > s.max_delivery_distance_m) {
        throw new AppError(422, 'ADDRESS_OUT_OF_RANGE', 'This restaurant does not deliver that far', {
            maxDistanceM: s.max_delivery_distance_m,
        });
    }

    return {
        distanceM: route.distanceM,
        durationS: route.durationS,
        feeMinor: deliveryFeeMinor(route.distanceM, {
            baseFeeMinor: s.delivery_fee_base_minor,
            baseKm: s.delivery_fee_base_km,
            perExtraKmMinor: s.delivery_fee_per_extra_km_minor,
        }),
    };
}

export { quoteDelivery };
export type { DeliveryQuote };