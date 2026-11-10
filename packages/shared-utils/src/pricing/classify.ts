import type { DeliveryType } from '@courier/constants';
import type { IntercityRoutePrice, LatLng, PricingRuleSet, ServiceArea } from '@courier/shared-types';
import { findServiceArea } from '../geo/distance.js';
import { PricingError } from './errors.js';

export interface Classification {
  deliveryType: DeliveryType;
  pickupArea: ServiceArea;
  destinationArea: ServiceArea | null;
  route: IntercityRoutePrice | null;
}

export function findRoute(
  rules: PricingRuleSet,
  originAreaId: string,
  destinationAreaId: string,
): IntercityRoutePrice | null {
  return (
    rules.intercity.routes.find(
      (r) =>
        (r.originAreaId === originAreaId && r.destinationAreaId === destinationAreaId) ||
        (r.bidirectional && r.originAreaId === destinationAreaId && r.destinationAreaId === originAreaId),
    ) ?? null
  );
}

/**
 * Decide the delivery type from the two locations (see docs/04 §4.1 rule 2).
 * Pickup must be inside an active service area because a company driver must collect it.
 */
export function classifyDelivery(
  rules: PricingRuleSet,
  areas: readonly ServiceArea[],
  pickup: LatLng,
  destination: LatLng,
): Classification {
  const pickupArea = findServiceArea(pickup, areas);
  if (!pickupArea) {
    throw new PricingError('PICKUP_NOT_SERVICED', 'We do not yet collect from this location.');
  }
  const destinationArea = findServiceArea(destination, areas);

  if (destinationArea && destinationArea.id === pickupArea.id) {
    return { deliveryType: 'intra_city', pickupArea, destinationArea, route: null };
  }
  if (destinationArea) {
    const route = findRoute(rules, pickupArea.id, destinationArea.id);
    if (route) return { deliveryType: 'intercity', pickupArea, destinationArea, route };
  }
  if (rules.longDistance.enabled) {
    return { deliveryType: 'long_distance', pickupArea, destinationArea, route: null };
  }
  throw new PricingError('DESTINATION_NOT_SERVICED', 'We do not yet deliver to this destination.');
}
