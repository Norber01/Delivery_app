import { TERMINAL_DELIVERY_STATUSES } from '@courier/constants';
import type { DeliveryStatus } from '@courier/constants';

/**
 * Legal delivery status transitions (docs/05-delivery-lifecycle.md §5.2).
 * `on_hold` is handled separately: any non-terminal status may go on hold and
 * return only to the status it was held from.
 */
export const DELIVERY_TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  awaiting_assignment: ['assigned', 'cancelled'],
  assigned: ['awaiting_assignment', 'en_route_to_pickup', 'cancelled'],
  en_route_to_pickup: ['picked_up', 'pickup_failed'],
  pickup_failed: ['awaiting_assignment', 'cancelled'],
  picked_up: ['out_for_delivery', 'at_origin_hub'],
  at_origin_hub: ['in_transit'],
  in_transit: ['at_destination_hub'],
  at_destination_hub: ['out_for_delivery', 'returning_to_sender'],
  out_for_delivery: ['delivered', 'delivery_failed'],
  delivery_failed: ['out_for_delivery', 'at_destination_hub', 'returning_to_sender'],
  returning_to_sender: ['returned'],
  on_hold: [],
  delivered: [],
  returned: [],
  cancelled: [],
};

export function isTerminalStatus(s: DeliveryStatus): boolean {
  return (TERMINAL_DELIVERY_STATUSES as readonly DeliveryStatus[]).includes(s);
}

/**
 * @param heldFrom when `from` is `on_hold`, the status the delivery was in before the hold.
 */
export function canTransition(from: DeliveryStatus, to: DeliveryStatus, heldFrom?: DeliveryStatus): boolean {
  if (from === to) return false;
  if (to === 'on_hold') return !isTerminalStatus(from) && from !== 'on_hold';
  if (from === 'on_hold') return heldFrom !== undefined && (to === heldFrom || to === 'cancelled');
  return DELIVERY_TRANSITIONS[from].includes(to);
}

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: DeliveryStatus,
    readonly to: DeliveryStatus,
  ) {
    super(`Illegal delivery status transition ${from} → ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: DeliveryStatus, to: DeliveryStatus, heldFrom?: DeliveryStatus): void {
  if (!canTransition(from, to, heldFrom)) throw new InvalidTransitionError(from, to);
}

/** Customer-facing wording for each status. */
export const PUBLIC_STATUS_LABELS: Readonly<Record<DeliveryStatus, string>> = {
  awaiting_assignment: 'Booking received',
  assigned: 'Driver assigned',
  en_route_to_pickup: 'Driver on the way to pickup',
  pickup_failed: 'Pickup attempt unsuccessful',
  picked_up: 'Package collected',
  at_origin_hub: 'At origin hub',
  in_transit: 'In transit between cities',
  at_destination_hub: 'At destination hub',
  out_for_delivery: 'Out for delivery',
  delivery_failed: 'Delivery attempt unsuccessful',
  returning_to_sender: 'Returning to sender',
  on_hold: 'On hold',
  delivered: 'Delivered',
  returned: 'Returned to sender',
  cancelled: 'Cancelled',
};
