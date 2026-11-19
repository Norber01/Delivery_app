import type { DeliveryStatus } from '@courier/constants';
import type { DeliveryDoc } from '@courier/shared-types';

/** What the driver should do next for a job, in plain words. */
export function nextStep(d: Pick<DeliveryDoc, 'status' | 'collectOnPickupPesewas'> & Partial<Pick<DeliveryDoc, 'originHub' | 'destinationHub'>>): string {
  switch (d.status) {
    case 'picked_up':
      return `Take the package to ${d.originHub?.name ?? 'the hub'}`;
    case 'at_destination_hub':
      return `Collect the package at ${d.destinationHub?.name ?? 'the hub'}`;
    case 'assigned':
      return 'Start the job when you set off to the pickup';
    case 'en_route_to_pickup':
      return d.collectOnPickupPesewas > 0 ? 'Collect payment, then scan the package label' : 'Scan the package label at pickup';
    case 'out_for_delivery':
      return 'Deliver and enter the recipient’s 6-digit code';
    case 'delivery_failed':
      return 'Waiting for dispatch: reattempt or return';
    case 'returning_to_sender':
      return 'Return the package to the sender and get a signature';
    default:
      return '';
  }
}

const ORDER: DeliveryStatus[] = ['out_for_delivery', 'picked_up', 'en_route_to_pickup', 'returning_to_sender', 'at_destination_hub', 'assigned', 'delivery_failed'];

/** Jobs in working order: packages in hand first, then pickups, then new assignments. */
export function sortJobs<T extends Pick<DeliveryDoc, 'status' | 'expectedDeliveryAt'>>(jobs: T[]): T[] {
  return [...jobs].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status) || a.expectedDeliveryAt.localeCompare(b.expectedDeliveryAt));
}

/** Navigation hand-off (Google Maps app on Android, browser elsewhere). */
export function navigationUrl(p: { lat: number; lng: number }, platform: 'android' | 'other'): string {
  return platform === 'android' ? `google.navigation:q=${p.lat},${p.lng}&mode=d` : `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}&travelmode=driving`;
}

export function newActionId(randomBytes: (n: number) => Uint8Array): string {
  return [...randomBytes(16)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Jobs in the order of the route plan (Phase 6): each job's position is its next planned stop.
 * Jobs the plan does not know (assigned after planning) follow in the usual order.
 */
export function orderByPlan<T extends Pick<DeliveryDoc, 'id' | 'status' | 'expectedDeliveryAt'>>(
  jobs: T[],
  plan: { stops: { deliveryId: string; seq: number; kind: 'pickup' | 'drop' }[] } | null,
): { job: T; stop: number | null }[] {
  const first = new Map<string, number>();
  for (const s of plan?.stops ?? []) if (!first.has(s.deliveryId)) first.set(s.deliveryId, s.seq);
  const planned = jobs.filter((j) => first.has(j.id)).sort((a, b) => first.get(a.id)! - first.get(b.id)!);
  const rest = sortJobs(jobs.filter((j) => !first.has(j.id)));
  return [...planned.map((job) => ({ job, stop: first.get(job.id)! })), ...rest.map((job) => ({ job, stop: null }))];
}

/** Parse an odometer reading typed by a driver ("12 345", "12,345") to whole km, or an error. */
export function parseOdometer(text: string): { km: number } | { error: string } {
  const clean = text.replace(/[\s,]/g, '');
  if (!/^\d{1,7}$/.test(clean)) return { error: 'Enter the odometer reading in kilometres (numbers only).' };
  return { km: Number(clean) };
}
