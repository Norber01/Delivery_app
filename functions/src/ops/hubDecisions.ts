/**
 * Hub custody decisions (docs/05 §5.4). Every hand-over between a driver, a hub and a linehaul
 * vehicle is a scan by an authorised person; each function enforces that the parcel is in the
 * expected custody at the expected hub, so a parcel can never be in two places at once.
 */
import { MAX_MANIFEST_PARCELS, type Role } from '@courier/constants';
import type { ManifestDoc, RouteDoc } from '@courier/shared-types';
import { PUBLIC_STATUS_LABELS } from '@courier/shared-utils';
import { AppError } from '../lib/errors.js';
import type { TrackingEventRecord } from '../store/types.js';
import { type DispatchDeps } from './decisions.js';
import type { DeliveryRecord, ManifestContext, ManifestMutation, OpsContext, OpsMutation } from './types.js';
import { POD_OTP } from '@courier/constants';
import { otpHash } from './decisions.js';

type Actor = { uid: string; role: Role };

const legOf = (d: DeliveryRecord) => d.legs.find((l) => l.id === d.currentLegId) ?? null;
const nextLegId = (d: DeliveryRecord) => {
  const i = d.legs.findIndex((l) => l.id === d.currentLegId);
  return d.legs[i + 1]?.id ?? d.currentLegId;
};
const setLeg = (d: DeliveryRecord, legId: string | null, patch: Partial<DeliveryRecord['legs'][number]>) =>
  d.legs.map((l) => (l.id === legId ? { ...l, ...patch } : l));

function ev(d: DeliveryRecord, now: Date, type: string, publicMessage: string, actor: Actor, extra: Partial<TrackingEventRecord> = {}): TrackingEventRecord {
  return { trackingNumber: d.trackingNumber, deliveryId: d.id, type, publicMessage, actorUid: actor.uid, actorRole: actor.role, occurredAt: now, ...extra };
}

const audit = (actor: Actor, action: string, targetType: string, targetId: string, after?: unknown) => ({
  actorUid: actor.uid,
  actorRole: actor.role,
  action,
  targetType,
  targetId,
  ...(after !== undefined ? { after } : {}),
});

// ---- Receive a parcel at a hub ------------------------------------------------------------

/**
 * Hub scan-in. Valid cases:
 * 1. first-mile driver drops the parcel at the origin hub   (picked_up → at_origin_hub)
 * 2. linehaul vehicle unloads at the destination hub         (in_transit → at_destination_hub)
 * 3. last-mile driver brings back a failed delivery          (delivery_failed → at_destination_hub)
 */
export function decideHubReceive(ctx: OpsContext, hubId: string, actor: Actor): OpsMutation {
  const d = ctx.delivery;
  const leg = legOf(d);
  const wrongHub = (expected: string | undefined) =>
    new AppError('WRONG_HUB', `This parcel belongs at ${expected ?? 'another hub'}, not this one. Do not keep it here — contact dispatch.`);

  if (d.status === 'picked_up' && leg?.type === 'first_mile') {
    if (d.originHub?.id !== hubId) throw wrongHub(d.originHub?.name);
    const next = nextLegId(d);
    return {
      ...(ctx.assignment ? { assignmentUpdate: { status: 'completed', endedAt: ctx.now } } : {}),
      delivery: {
        status: 'at_origin_hub',
        custodian: { type: 'hub', id: hubId },
        legs: setLeg({ ...d, legs: setLeg(d, leg.id, { status: 'completed' }) }, next, { status: 'planned' }),
        currentLegId: next,
        currentAssignmentId: null,
        currentDriverUid: null,
      },
      events: [ev(d, ctx.now, 'hub_in', `Arrived at our ${d.originHub.city} hub`, actor, { internalNote: `Received at ${d.originHub.code} from first-mile driver` })],
      audit: [audit(actor, 'hub.receive', 'delivery', d.id, { hubId, from: 'first_mile' })],
    };
  }

  if (d.status === 'in_transit' && leg?.type === 'linehaul') {
    if (d.destinationHub?.id !== hubId) throw wrongHub(d.destinationHub?.name);
    // Unload only after arrival is recorded; a closed manifest still accepts parcels found later.
    if (!ctx.manifest || !['arrived', 'closed'].includes(ctx.manifest.status)) {
      throw new AppError('INVALID_TRANSITION', 'Mark the vehicle as arrived before unloading its parcels.');
    }
    const next = nextLegId(d);
    return {
      manifestReceived: d.id,
      delivery: {
        status: 'at_destination_hub',
        custodian: { type: 'hub', id: hubId },
        legs: setLeg({ ...d, legs: setLeg(d, leg.id, { status: 'completed' }) }, next, { status: 'planned' }),
        currentLegId: next,
        openException: d.openException === 'missing_in_transit' ? null : d.openException,
      },
      events: [ev(d, ctx.now, 'hub_in', `Arrived at our ${d.destinationHub.city} hub`, actor, { internalNote: `Unloaded from manifest ${ctx.manifest.number}` })],
      audit: [audit(actor, 'hub.receive', 'delivery', d.id, { hubId, from: 'linehaul', manifestId: ctx.manifest.id })],
    };
  }

  if (d.status === 'delivery_failed' && leg?.type === 'last_mile' && d.custodian.type === 'driver') {
    if (d.destinationHub?.id !== hubId) throw wrongHub(d.destinationHub?.name);
    return {
      ...(ctx.assignment ? { assignmentUpdate: { status: 'failed', endedAt: ctx.now } } : {}),
      podSecret: null,
      delivery: {
        status: 'at_destination_hub',
        custodian: { type: 'hub', id: hubId },
        legs: setLeg(d, leg.id, { status: 'planned', assignmentId: null, driverUid: null, vehicleId: null }),
        currentAssignmentId: null,
        currentDriverUid: null,
      },
      events: [ev(d, ctx.now, 'hub_in', `Back at our ${d.destinationHub.city} hub after a delivery attempt`, actor)],
      audit: [audit(actor, 'hub.receive', 'delivery', d.id, { hubId, from: 'failed_last_mile' })],
    };
  }

  if (d.custodian.type === 'hub' && d.custodian.id === hubId) {
    throw new AppError('INVALID_TRANSITION', 'This parcel is already recorded at this hub.');
  }
  throw new AppError('INVALID_TRANSITION', `This parcel is "${PUBLIC_STATUS_LABELS[d.status]}" and cannot be received at a hub now.`);
}

// ---- Hand a parcel to the assigned last-mile driver ---------------------------------------------

export function decideHubHandover(ctx: OpsContext, hubId: string, actor: Actor, deps: Pick<DispatchDeps, 'newOtp' | 'site'>): OpsMutation {
  const d = ctx.delivery;
  const leg = legOf(d);
  if (d.status !== 'at_destination_hub' || d.custodian.type !== 'hub' || leg?.type !== 'last_mile') {
    throw new AppError('INVALID_TRANSITION', 'Only parcels waiting at the destination hub can be handed to a driver.');
  }
  if (d.custodian.id !== hubId) throw new AppError('WRONG_HUB', 'This parcel is recorded at a different hub.');
  const a = ctx.assignment;
  const driver = ctx.driver;
  if (!a || a.status !== 'assigned' || !d.currentDriverUid || !driver || driver.uid !== d.currentDriverUid) {
    throw new AppError('DRIVER_UNAVAILABLE', 'No driver is assigned to this parcel yet. Ask dispatch to assign one.');
  }
  if (!driver.currentShift || new Date(driver.currentShift.activeUntil) <= ctx.now) {
    throw new AppError('SHIFT_REQUIRED', 'The assigned driver is not on shift.');
  }
  const otp = deps.newOtp();
  return {
    assignmentUpdate: { status: 'started', startedAt: ctx.now },
    podSecret: { deliveryId: d.id, otpHash: otpHash(d.id, otp), attempts: 0, locked: false, expiresAt: new Date(ctx.now.getTime() + POD_OTP.ttlHours * 3600_000) },
    delivery: {
      status: 'out_for_delivery',
      custodian: { type: 'driver', id: driver.uid },
      legs: setLeg(d, leg.id, { status: 'in_progress' }),
      attempts: d.attempts + 1,
      openException: null,
    },
    events: [ev(d, ctx.now, 'out_for_delivery', PUBLIC_STATUS_LABELS.out_for_delivery, actor, { internalNote: `Handed to ${driver.name} at hub` })],
    notifications: [
      {
        channel: 'sms',
        recipientPhone: d.recipient.phone,
        template: 'delivery_otp',
        trackingNumber: d.trackingNumber,
        body: `${deps.site.companyName}: your package ${d.trackingNumber} is on its way. Give the driver code ${otp} on delivery. Track: ${deps.site.publicUrl}/track/${d.trackingNumber}`,
      },
    ],
    audit: [audit(actor, 'hub.handover', 'delivery', d.id, { hubId, driverUid: driver.uid })],
  };
}

// ---- Manifests --------------------------------------------------------------------------------

export function decideAddToManifest(ctx: ManifestContext, deliveryId: string, actor: Actor): ManifestMutation {
  const m = ctx.manifest;
  const d = ctx.deliveries.find((x) => x.id === deliveryId);
  if (!d) throw new AppError('DELIVERY_NOT_FOUND', 'Parcel not found.', 'not-found');
  if (m.status !== 'open') throw new AppError('MANIFEST_NOT_OPEN', 'This manifest is sealed. Reopen it to make changes.');
  const leg = legOf(d);
  if (m.deliveryIds.includes(d.id)) return {}; // already loaded (repeat scan)
  if (d.status !== 'at_origin_hub' || d.custodian.type !== 'hub' || d.custodian.id !== m.originHubId) {
    throw new AppError('WRONG_HUB', 'This parcel has not been received at this hub.');
  }
  if (d.routeId !== m.routeId) throw new AppError('ROUTE_MISMATCH', `This parcel goes to ${d.destinationHub?.city ?? 'another city'}, not on this route.`);
  if (leg?.type !== 'linehaul') throw new AppError('INVALID_TRANSITION', 'This parcel is not waiting for a linehaul.');
  if (leg.manifestId) throw new AppError('ALREADY_ON_MANIFEST', 'This parcel is already on another manifest.');
  if (m.deliveryIds.length >= MAX_MANIFEST_PARCELS) throw new AppError('MANIFEST_CAPACITY', `A manifest holds at most ${MAX_MANIFEST_PARCELS} parcels.`);
  const weight = Math.round((m.totalWeightKg + d.chargeableWeightKg) * 10) / 10;
  if (weight > m.capacityKg) {
    throw new AppError('MANIFEST_CAPACITY', `Adding this parcel (${d.chargeableWeightKg} kg) exceeds the vehicle capacity of ${m.capacityKg} kg.`);
  }
  return {
    manifest: { deliveryIds: [...m.deliveryIds, d.id], totalWeightKg: weight },
    deliveries: [{ id: d.id, patch: { legs: setLeg(d, leg.id, { manifestId: m.id, status: 'assigned' }) } }],
    audit: [audit(actor, 'manifest.add', 'manifest', m.id, { deliveryId: d.id })],
  };
}

export function decideRemoveFromManifest(ctx: ManifestContext, deliveryId: string, actor: Actor): ManifestMutation {
  const m = ctx.manifest;
  if (m.status !== 'open') throw new AppError('MANIFEST_NOT_OPEN', 'This manifest is sealed. Reopen it to make changes.');
  const d = ctx.deliveries.find((x) => x.id === deliveryId);
  if (!d || !m.deliveryIds.includes(deliveryId)) throw new AppError('NOT_FOUND', 'This parcel is not on the manifest.', 'not-found');
  const leg = legOf(d);
  return {
    manifest: { deliveryIds: m.deliveryIds.filter((x) => x !== deliveryId), totalWeightKg: Math.max(0, Math.round((m.totalWeightKg - d.chargeableWeightKg) * 10) / 10) },
    deliveries: [{ id: d.id, patch: { legs: setLeg(d, leg?.id ?? null, { manifestId: null, status: 'planned' }) } }],
    audit: [audit(actor, 'manifest.remove', 'manifest', m.id, { deliveryId })],
  };
}

export function decideManifestAction(ctx: ManifestContext, action: 'seal' | 'reopen' | 'depart' | 'arrive' | 'close', actor: Actor): ManifestMutation {
  const m = ctx.manifest;
  const now = ctx.now;
  const bad = (msg: string) => new AppError('INVALID_TRANSITION', msg);
  switch (action) {
    case 'seal':
      if (m.status !== 'open') throw bad('Only open manifests can be sealed.');
      if (m.deliveryIds.length === 0) throw bad('Load at least one parcel before sealing.');
      return { manifest: { status: 'sealed' }, audit: [audit(actor, 'manifest.seal', 'manifest', m.id, { parcels: m.deliveryIds.length, totalWeightKg: m.totalWeightKg })] };
    case 'reopen':
      if (m.status !== 'sealed') throw bad('Only sealed manifests can be reopened.');
      return { manifest: { status: 'open' }, audit: [audit(actor, 'manifest.reopen', 'manifest', m.id)] };
    case 'depart': {
      if (m.status !== 'sealed') throw bad('Seal the manifest before departure.');
      const route = ctx.route as RouteDoc | null;
      if (!route) throw new AppError('HUB_NOT_CONFIGURED', 'The route for this manifest no longer exists.');
      const driver = ctx.driver;
      if (!driver?.currentShift || new Date(driver.currentShift.activeUntil) <= now || driver.currentShift.vehicleId !== m.vehicleId) {
        throw new AppError('DRIVER_UNAVAILABLE', `${m.driverName} must be on shift with vehicle ${m.vehicleRegistration} before departure.`);
      }
      const notReady = ctx.deliveries.filter((d) => d.status !== 'at_origin_hub' || d.custodian.type !== 'hub' || d.custodian.id !== m.originHubId);
      if (notReady.length) throw bad(`These parcels are no longer at the hub: ${notReady.map((d) => d.trackingNumber).join(', ')}. Remove them first.`);
      const expectedArrivalAt = new Date(now.getTime() + route.typicalDurationMinutes * 60_000).toISOString();
      const departedAt = now.toISOString();
      return {
        manifest: { status: 'departed', departedAt, expectedArrivalAt },
        deliveries: ctx.deliveries.map((d) => ({
          id: d.id,
          patch: {
            status: 'in_transit' as const,
            custodian: { type: 'vehicle' as const, id: m.vehicleId },
            legs: setLeg(d, d.currentLegId, { status: 'in_progress', driverUid: m.driverUid, vehicleId: m.vehicleId }),
            linehaul: { manifestId: m.id, departedAt, expectedArrivalAt },
          },
        })),
        events: ctx.deliveries.map((d) =>
          ev(d, now, 'departed', `In transit from ${d.originHub?.city ?? 'origin'} to ${d.destinationHub?.city ?? 'destination'}`, actor, {
            internalNote: `Manifest ${m.number}, vehicle ${m.vehicleRegistration}`,
          }),
        ),
        audit: [audit(actor, 'manifest.depart', 'manifest', m.id, { parcels: m.deliveryIds.length })],
      };
    }
    case 'arrive':
      if (m.status !== 'departed') throw bad('Only a departed manifest can arrive.');
      return { manifest: { status: 'arrived', arrivedAt: now.toISOString() }, audit: [audit(actor, 'manifest.arrive', 'manifest', m.id)] };
    case 'close': {
      if (m.status !== 'arrived') throw bad('Mark the manifest as arrived and unload it before closing.');
      const missing = m.deliveryIds.filter((id) => !m.receivedIds.includes(id));
      const missingDeliveries = ctx.deliveries.filter((d) => missing.includes(d.id) && d.status === 'in_transit');
      return {
        manifest: { status: 'closed', closedAt: now.toISOString(), missingIds: missing },
        deliveries: missingDeliveries.map((d) => ({
          id: d.id,
          patch: {
            openException: 'missing_in_transit' as const,
            exceptions: [...d.exceptions, { reason: 'missing_in_transit' as const, note: `Not unloaded from manifest ${m.number}`, at: now.toISOString(), byUid: actor.uid, stage: 'delivery' as const }].slice(-20),
          },
        })),
        events: missingDeliveries.map((d) => ev(d, now, 'exception', 'Delayed in transit — our team is checking', actor, { internalNote: `Missing at unloading of ${m.number}` })),
        audit: [audit(actor, missing.length ? 'manifest.close_with_discrepancy' : 'manifest.close', 'manifest', m.id, { missing })],
      };
    }
  }
}

export type { ManifestDoc };
