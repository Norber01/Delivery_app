/**
 * Pure decisions for delivery operations (docs/05-delivery-lifecycle.md). Each takes the
 * freshly-read transaction context and returns the writes to apply, or throws AppError.
 * No I/O here, so every rule is unit-testable.
 */
import {
  DELIVERY_WINDOWS_HOURS,
  POD_DISTANCE_FLAG_METERS,
  POD_OTP,
  VEHICLE_RANK,
  type DeliveryStatus,
  type ExceptionReason,
  type Role,
} from '@courier/constants';
import type { DriverDoc, LatLng, ShipmentLeg } from '@courier/shared-types';
import { canTransition, distanceMeters, formatGhs, normalizeTrackingNumber, PUBLIC_STATUS_LABELS } from '@courier/shared-utils';
import type { ValidDispatchAction, ValidDriverAction } from '@courier/validation';
import { AppError } from '../lib/errors.js';
import { sha256Hex } from '../lib/hash.js';
import type { BookingRecord, NewNotification, TrackingEventRecord } from '../store/types.js';
import type { AssignmentRecord, DeliveryRecord, NetworkRoute, OpsContext, OpsMutation, PodSecret } from './types.js';
import type { VehicleClass } from '@courier/constants';

/** Smallest class for a weight when pricing chose none (intercity): first/last-mile vehicle check. */
export function vehicleClassForWeight(kg: number): VehicleClass {
  return kg <= 20 ? 'motorbike' : kg <= 100 ? 'car' : kg <= 1000 ? 'van' : 'truck';
}

export interface Site {
  publicUrl: string;
  companyName: string;
}

export const otpHash = (deliveryId: string, otp: string) => sha256Hex(`${deliveryId}:${otp}`);

function ensureTransition(from: DeliveryStatus, to: DeliveryStatus, heldFrom?: DeliveryStatus | null) {
  if (!canTransition(from, to, heldFrom ?? undefined)) {
    throw new AppError('INVALID_TRANSITION', `This delivery is "${PUBLIC_STATUS_LABELS[from]}" and cannot move to "${PUBLIC_STATUS_LABELS[to]}".`);
  }
}

const event = (
  ctx: OpsContext,
  type: string,
  publicMessage: string,
  actor: { uid: string | null; role: Role | 'system' },
  extra: Partial<TrackingEventRecord> = {},
  offsetMs = 0,
): TrackingEventRecord => ({
  trackingNumber: ctx.delivery.trackingNumber,
  deliveryId: ctx.delivery.id,
  type,
  publicMessage,
  actorUid: actor.uid,
  actorRole: actor.role,
  occurredAt: new Date(ctx.now.getTime() + offsetMs),
  ...extra,
});

const sms = (to: string, template: string, trackingNumber: string, body: string): NewNotification => ({
  channel: 'sms',
  recipientPhone: to,
  template,
  trackingNumber,
  body,
});

const updateLeg = (legs: ShipmentLeg[], legId: string | null, patch: Partial<ShipmentLeg>) =>
  legs.map((l) => (l.id === legId ? { ...l, ...patch } : l));

// ---- Delivery creation -------------------------------------------------------------

/** Build the operational delivery for a confirmed booking. */
export function buildDelivery(b: BookingRecord, now: Date, network: NetworkRoute | null = null): DeliveryRecord {
  const legs: ShipmentLeg[] =
    b.deliveryType === 'intercity'
      ? (['first_mile', 'linehaul', 'last_mile'] as const).map((type, i) => ({
          id: `leg${i + 1}`,
          sequence: i + 1,
          type,
          status: 'planned',
          assignmentId: null,
          driverUid: null,
          vehicleId: null,
        }))
      : [{ id: 'leg1', sequence: 1, type: 'direct', status: 'planned', assignmentId: null, driverUid: null, vehicleId: null }];
  const hours = DELIVERY_WINDOWS_HOURS[b.deliveryType][b.urgency];
  return {
    id: b.trackingNumber,
    trackingNumber: b.trackingNumber,
    deliveryType: b.deliveryType,
    urgency: b.urgency,
    status: 'awaiting_assignment',
    heldFrom: null,
    holdReason: null,
    serviceAreaId: b.pickupAreaId,
    requiredVehicleClass: b.price.vehicleClass ?? vehicleClassForWeight(b.price.chargeableWeightKg),
    destinationAreaId: b.destinationAreaId,
    chargeableWeightKg: b.price.chargeableWeightKg,
    originHub: network?.originHub ?? null,
    destinationHub: network?.destinationHub ?? null,
    routeId: network?.route.id ?? null,
    linehaul: null,
    sender: b.sender,
    recipient: b.recipient,
    pickup: b.pickup,
    destination: b.destination,
    packages: b.packages,
    specialHandling: b.specialHandling,
    instructions: b.instructions,
    paymentPreference: b.paymentPreference,
    collectOnPickupPesewas: b.paymentPreference === 'cash_on_pickup' && b.paymentStatus === 'unpaid' ? b.price.totalPesewas : 0,
    legs,
    currentLegId: 'leg1',
    currentAssignmentId: null,
    currentDriverUid: null,
    custodian: { type: 'none' },
    exceptions: [],
    openException: null,
    expectedDeliveryAt: new Date(now.getTime() + hours * 3600_000).toISOString(),
    delayed: false,
    attempts: 0,
    eta: null,
    driverUids: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ---- Dispatch ---------------------------------------------------------------------------

export interface DispatchDeps {
  actor: { uid: string; role: Role };
  newId: () => string;
  newOtp: () => string;
  site: Site;
}

function driverIsAvailable(d: DriverDoc | null, ctx: OpsContext): d is DriverDoc & { currentShift: NonNullable<DriverDoc['currentShift']> } {
  return Boolean(d && d.status === 'active' && d.currentShift && new Date(d.currentShift.activeUntil) > ctx.now);
}

/** New OTP for the recipient; returned secret + SMS. */
function issueOtp(ctx: OpsContext, deps: { newOtp: () => string; site: Site }): { secret: PodSecret; notification: NewNotification } {
  const otp = deps.newOtp();
  const d = ctx.delivery;
  return {
    secret: {
      deliveryId: d.id,
      otpHash: otpHash(d.id, otp),
      attempts: 0,
      locked: false,
      expiresAt: new Date(ctx.now.getTime() + POD_OTP.ttlHours * 3600_000),
    },
    notification: sms(
      d.recipient.phone,
      'delivery_otp',
      d.trackingNumber,
      `${deps.site.companyName}: your package ${d.trackingNumber} is on its way. Give the driver code ${otp} on delivery. Track: ${deps.site.publicUrl}/track/${d.trackingNumber}`,
    ),
  };
}

export function decideDispatch(ctx: OpsContext, a: ValidDispatchAction, deps: DispatchDeps): OpsMutation {
  const d = ctx.delivery;
  const actor = { uid: deps.actor.uid, role: deps.actor.role };
  const audit = [{ actorUid: deps.actor.uid, actorRole: deps.actor.role, action: `dispatch.${a.type}`, targetType: 'delivery', targetId: d.id, after: { from: d.status, driverUid: a.driverUid ?? null, reason: a.reason ?? null } }];
  const leg = d.legs.find((l) => l.id === d.currentLegId) ?? null;

  switch (a.type) {
    case 'assign': {
      if (!leg || leg.type === 'linehaul') {
        throw new AppError('INVALID_TRANSITION', 'This parcel travels between hubs on a manifest. Use the hub screen.');
      }
      const lastMile = leg.type === 'last_mile';
      if (lastMile) {
        if (d.status !== 'at_destination_hub' || d.currentAssignmentId) {
          throw new AppError('INVALID_TRANSITION', 'The parcel must be at the destination hub with no driver assigned.');
        }
      } else {
        ensureTransition(d.status, 'assigned');
      }
      if (leg.type !== 'direct' && (!d.originHub || !d.destinationHub)) {
        throw new AppError('HUB_NOT_CONFIGURED', 'No hubs or route are set up between these cities. Configure the network first.');
      }
      const driver = ctx.driver;
      if (!driverIsAvailable(driver, ctx) || driver.uid !== a.driverUid) {
        throw new AppError('DRIVER_UNAVAILABLE', 'This driver is not on an active shift.');
      }
      const area = lastMile ? d.destinationAreaId : d.serviceAreaId;
      if (driver.currentShift.serviceAreaId !== area) {
        throw new AppError('DRIVER_UNAVAILABLE', 'This driver is working in a different service area.');
      }
      if (d.requiredVehicleClass && VEHICLE_RANK[driver.currentShift.vehicleClass] < VEHICLE_RANK[d.requiredVehicleClass]) {
        throw new AppError('VEHICLE_TOO_SMALL', `This delivery needs at least a ${d.requiredVehicleClass}; the driver has a ${driver.currentShift.vehicleClass}.`);
      }
      const assignment: AssignmentRecord = {
        id: `as_${deps.newId()}`,
        deliveryId: d.id,
        legId: leg.id,
        driverUid: driver.uid,
        vehicleId: driver.currentShift.vehicleId,
        status: 'assigned',
        assignedBy: deps.actor.uid,
        createdAt: ctx.now,
        startedAt: null,
        endedAt: null,
      };
      return {
        assignmentCreate: assignment,
        addDriverUid: driver.uid,
        delivery: {
          // Last mile: the parcel stays at the hub until the hub team hands it to the driver.
          status: lastMile ? 'at_destination_hub' : 'assigned',
          currentAssignmentId: assignment.id,
          currentDriverUid: driver.uid,
          legs: updateLeg(d.legs, leg.id, { status: 'assigned', assignmentId: assignment.id, driverUid: driver.uid, vehicleId: assignment.vehicleId }),
          openException: null,
        },
        events: [
          event(ctx, 'assigned', lastMile ? 'Driver assigned for final delivery' : 'Driver assigned', actor, {
            internalNote: `${leg.type} assigned to ${driver.name} (${driver.currentShift.vehicleClass})`,
          }),
        ],
        audit,
      };
    }
    case 'unassign': {
      if (leg?.type === 'last_mile') {
        if (d.status !== 'at_destination_hub' || ctx.assignment?.status !== 'assigned') {
          throw new AppError('INVALID_TRANSITION', 'Only a last-mile driver who has not collected the parcel can be unassigned.');
        }
        return {
          assignmentUpdate: { status: 'cancelled', endedAt: ctx.now },
          delivery: {
            currentAssignmentId: null,
            currentDriverUid: null,
            legs: updateLeg(d.legs, d.currentLegId, { status: 'planned', assignmentId: null, driverUid: null, vehicleId: null }),
          },
          events: [event(ctx, 'unassigned', PUBLIC_STATUS_LABELS.at_destination_hub, actor)],
          audit,
        };
      }
      ensureTransition(d.status, 'awaiting_assignment');
      if (d.status !== 'assigned') throw new AppError('INVALID_TRANSITION', 'Only deliveries not yet started can be unassigned.');
      return {
        assignmentUpdate: { status: 'cancelled', endedAt: ctx.now },
        delivery: {
          status: 'awaiting_assignment',
          currentAssignmentId: null,
          currentDriverUid: null,
          legs: updateLeg(d.legs, d.currentLegId, { status: 'planned', assignmentId: null, driverUid: null, vehicleId: null }),
        },
        events: [event(ctx, 'unassigned', 'Awaiting driver assignment', actor)],
        audit,
      };
    }
    case 'reschedule': {
      if (d.status !== 'pickup_failed') throw new AppError('INVALID_TRANSITION', 'Only failed pickups can be rescheduled.');
      return {
        delivery: { status: 'awaiting_assignment', openException: null },
        events: [event(ctx, 'rescheduled', 'Pickup rescheduled', actor)],
        audit,
      };
    }
    case 'reattempt': {
      ensureTransition(d.status, 'out_for_delivery');
      if (d.status !== 'delivery_failed' || d.custodian.type !== 'driver') throw new AppError('INVALID_TRANSITION', 'Only a failed delivery still held by its driver can be reattempted.');
      const { secret, notification } = issueOtp(ctx, deps);
      return {
        podSecret: secret,
        delivery: { status: 'out_for_delivery', openException: null },
        events: [event(ctx, 'out_for_delivery', 'Out for delivery (new attempt)', actor)],
        notifications: [notification],
        audit,
      };
    }
    case 'return_to_sender': {
      if (d.deliveryType === 'intercity') {
        throw new AppError(
          'PHASE_NOT_AVAILABLE',
          'Intercity returns are not automated yet: have the driver bring the parcel back to the hub, hold it, and arrange the return with the sender.',
        );
      }
      ensureTransition(d.status, 'returning_to_sender');
      if (d.custodian.type !== 'driver') throw new AppError('PHASE_NOT_AVAILABLE', 'Returns from a hub are handled by hub operations (Phase 4).');
      return {
        podSecret: null,
        delivery: { status: 'returning_to_sender', openException: null },
        events: [event(ctx, 'returning_to_sender', PUBLIC_STATUS_LABELS.returning_to_sender, actor)],
        notifications: [
          sms(d.sender.phone, 'returning_to_sender', d.trackingNumber, `${deps.site.companyName}: we could not deliver ${d.trackingNumber}. It is being returned to you.`),
        ],
        audit,
      };
    }
    case 'cancel': {
      const effective = d.status === 'on_hold' ? d.heldFrom : d.status;
      if (!effective || !['awaiting_assignment', 'assigned', 'pickup_failed'].includes(effective)) {
        throw new AppError('INVALID_TRANSITION', 'Deliveries can only be cancelled before the package is collected.');
      }
      const paid = ctx.booking.paymentStatus === 'paid';
      return {
        ...(ctx.assignment && ctx.assignment.status !== 'cancelled' && ctx.assignment.status !== 'failed' ? { assignmentUpdate: { status: 'cancelled', endedAt: ctx.now } } : {}),
        delivery: { status: 'cancelled', currentAssignmentId: null, currentDriverUid: null, heldFrom: null, openException: null },
        booking: { status: 'cancelled' },
        events: [event(ctx, 'cancelled', PUBLIC_STATUS_LABELS.cancelled, actor, { internalNote: a.reason ?? undefined })],
        notifications: [sms(d.sender.phone, 'booking_cancelled', d.trackingNumber, `${deps.site.companyName}: booking ${d.trackingNumber} has been cancelled.${paid ? ' Any payment will be refunded.' : ''}`)],
        audit: [...audit, ...(paid ? [{ actorUid: deps.actor.uid, actorRole: deps.actor.role, action: 'refund.required', targetType: 'deliveryRequest', targetId: d.trackingNumber, after: { reason: 'cancelled after payment' } }] : [])],
      };
    }
    case 'hold': {
      ensureTransition(d.status, 'on_hold');
      return {
        delivery: { status: 'on_hold', heldFrom: d.status, holdReason: a.reason ?? null },
        events: [event(ctx, 'on_hold', PUBLIC_STATUS_LABELS.on_hold, actor, { internalNote: a.reason ?? undefined })],
        audit,
      };
    }
    case 'release': {
      if (d.status !== 'on_hold' || !d.heldFrom) throw new AppError('INVALID_TRANSITION', 'This delivery is not on hold.');
      return {
        delivery: { status: d.heldFrom, heldFrom: null, holdReason: null },
        events: [event(ctx, 'released', PUBLIC_STATUS_LABELS[d.heldFrom], actor)],
        audit,
      };
    }
  }
}

// ---- Driver actions ----------------------------------------------------------------------

export interface DriverDeps {
  driverUid: string;
  newOtp: () => string;
  site: Site;
  /** Keys confirmed to exist in evidence storage and to belong to this driver + delivery. */
  verifiedPhotoKeys: string[];
}

function exception(ctx: OpsContext, reason: ExceptionReason, note: string | undefined, uid: string, stage: 'pickup' | 'delivery') {
  return {
    exceptions: [...ctx.delivery.exceptions, { reason, note: note ?? null, at: ctx.now.toISOString(), byUid: uid, stage }].slice(-20),
    openException: reason,
  };
}

function podLocation(ctx: OpsContext, loc: LatLng | undefined) {
  if (!loc) return { location: null, distanceFromDestinationM: null, flaggedFarFromDestination: false };
  const target = ctx.delivery.status === 'returning_to_sender' ? ctx.delivery.pickup.location : ctx.delivery.destination.location;
  const m = Math.round(distanceMeters(loc, target));
  return { location: loc, distanceFromDestinationM: m, flaggedFarFromDestination: m > POD_DISTANCE_FLAG_METERS };
}

export function decideDriverAction(ctx: OpsContext, a: ValidDriverAction, deps: DriverDeps): OpsMutation {
  const d = ctx.delivery;
  const uid = deps.driverUid;
  const actor = { uid, role: 'driver' as const };
  if (d.currentDriverUid !== uid || !ctx.assignment || ctx.assignment.driverUid !== uid) {
    throw new AppError('NOT_ASSIGNED_TO_YOU', 'This delivery is not assigned to you.', 'permission-denied');
  }
  const shiftActive = Boolean(ctx.driver?.currentShift && new Date(ctx.driver.currentShift.activeUntil) > ctx.now);
  const at = { location: a.location ?? undefined };
  const audit = [{ actorUid: uid, actorRole: 'driver' as const, action: `driver.${a.type}`, targetType: 'delivery', targetId: d.id }];

  switch (a.type) {
    case 'start_assignment': {
      if (!shiftActive) throw new AppError('SHIFT_REQUIRED', 'Start your shift before starting a job.');
      ensureTransition(d.status, 'en_route_to_pickup');
      return {
        assignmentUpdate: { status: 'started', startedAt: ctx.now },
        delivery: { status: 'en_route_to_pickup', legs: updateLeg(d.legs, d.currentLegId, { status: 'in_progress' }) },
        events: [event(ctx, 'en_route_to_pickup', PUBLIC_STATUS_LABELS.en_route_to_pickup, actor, at)],
        audit,
      };
    }
    case 'confirm_pickup': {
      if (!shiftActive) throw new AppError('SHIFT_REQUIRED', 'Start your shift before collecting packages.');
      ensureTransition(d.status, 'picked_up');
      if (normalizeTrackingNumber(a.scannedCode) !== d.trackingNumber) {
        throw new AppError('WRONG_PACKAGE', 'The scanned label does not match this delivery.');
      }
      const collect = d.collectOnPickupPesewas > 0 && ctx.booking.paymentStatus === 'unpaid';
      if (collect && !a.cashCollected) {
        throw new AppError('CASH_NOT_CONFIRMED', `Collect ${formatGhs(d.collectOnPickupPesewas)} from the sender before taking the package.`);
      }
      const toHub = d.legs.find((l) => l.id === d.currentLegId)?.type === 'first_mile';
      // Intercity first mile ends at the origin hub (scanned in there); direct pickups go straight out.
      const otp = toHub ? null : issueOtp(ctx, deps);
      const m: OpsMutation = {
        ...(otp ? { podSecret: otp.secret } : {}),
        delivery: {
          status: toHub ? 'picked_up' : 'out_for_delivery',
          custodian: { type: 'driver', id: uid },
          collectOnPickupPesewas: 0,
          openException: null,
          ...(toHub ? {} : { attempts: d.attempts + 1 }),
        },
        events: toHub
          ? [event(ctx, 'picked_up', `Package collected — on the way to our ${d.originHub?.city ?? ''} hub`.trim(), actor, at)]
          : [event(ctx, 'picked_up', PUBLIC_STATUS_LABELS.picked_up, actor, at), event(ctx, 'out_for_delivery', PUBLIC_STATUS_LABELS.out_for_delivery, actor, at, 2)],
        notifications: otp ? [otp.notification] : [],
        audit,
      };
      if (collect) {
        m.booking = { paymentStatus: 'paid' };
        m.payment = {
          id: `cash_${d.trackingNumber}`,
          provider: 'cash',
          reference: `${d.trackingNumber}-CASH`,
          trackingNumber: d.trackingNumber,
          customerUid: ctx.booking.customerUid,
          businessId: ctx.booking.businessId,
          amountPesewas: d.collectOnPickupPesewas,
          currency: 'GHS',
          status: 'succeeded',
          reviewReason: null,
          channel: 'cash',
          providerTransactionId: null,
          verificationSource: 'driver_collection',
          collectedBy: uid,
          refundedPesewas: 0,
          refundPendingPesewas: 0,
          createdAt: ctx.now,
          updatedAt: ctx.now,
          lastVerifiedAt: ctx.now,
          paidAt: ctx.now,
        };
        // +1 ms: keeps "Package collected → Payment received → Out for delivery" in order.
        m.events!.splice(1, 0, event(ctx, 'payment_received', 'Payment received', actor, {}, 1));
        m.audit!.push({ actorUid: uid, actorRole: 'driver', action: 'payment.cash_collected', targetType: 'payment', targetId: `cash_${d.trackingNumber}`, after: { amountPesewas: d.collectOnPickupPesewas } });
      }
      return m;
    }
    case 'report_pickup_failed': {
      ensureTransition(d.status, 'pickup_failed');
      return {
        assignmentUpdate: { status: 'failed', endedAt: ctx.now },
        delivery: {
          status: 'pickup_failed',
          currentAssignmentId: null,
          currentDriverUid: null,
          legs: updateLeg(d.legs, d.currentLegId, { status: 'planned', assignmentId: null, driverUid: null, vehicleId: null }),
          ...exception(ctx, a.reason, a.note, uid, 'pickup'),
        },
        events: [event(ctx, 'pickup_failed', PUBLIC_STATUS_LABELS.pickup_failed, actor, { ...at, internalNote: `${a.reason}${a.note ? `: ${a.note}` : ''}` })],
        audit,
      };
    }
    case 'complete_delivery': {
      ensureTransition(d.status, 'delivered');
      const secret = ctx.podSecret;
      if (!secret) throw new AppError('INVALID_TRANSITION', 'No delivery code was issued for this delivery. Contact dispatch.');
      const photos = a.photoKeys ?? [];
      if (photos.some((k) => !deps.verifiedPhotoKeys.includes(k))) {
        throw new AppError('UPLOAD_NOT_FOUND', 'A photo has not finished uploading. Try again.');
      }
      if (d.specialHandling.includes('high_value') && photos.length === 0) {
        throw new AppError('EVIDENCE_REQUIRED', 'High-value deliveries need a photo as proof of delivery.');
      }
      let method: 'otp' | 'signature';
      if (a.otp) {
        if (secret.locked || secret.expiresAt <= ctx.now) {
          throw new AppError('OTP_LOCKED', 'The delivery code can no longer be used. Capture a signature and photo instead.');
        }
        if (otpHash(d.id, a.otp) !== secret.otpHash) {
          const attempts = secret.attempts + 1;
          const locked = attempts >= POD_OTP.maxAttempts;
          return {
            podSecret: { ...secret, attempts, locked },
            audit: [{ actorUid: uid, actorRole: 'driver', action: 'pod.otp_failed', targetType: 'delivery', targetId: d.id, after: { attempts } }],
            fail: locked
              ? new AppError('OTP_LOCKED', 'Too many wrong codes. Capture the recipient’s signature and a photo instead.')
              : new AppError('OTP_INVALID', `That code is not correct. ${POD_OTP.maxAttempts - attempts} attempt(s) left.`),
          };
        }
        method = 'otp';
      } else {
        // Without the code, only after the code is locked/expired, with signature and photo.
        if (!(secret.locked || secret.expiresAt <= ctx.now)) {
          throw new AppError('EVIDENCE_REQUIRED', 'Ask the recipient for the 6-digit code sent to their phone.');
        }
        if (!a.signature || photos.length === 0) {
          throw new AppError('EVIDENCE_REQUIRED', 'Capture the recipient’s signature and a photo.');
        }
        method = 'signature';
      }
      const loc = podLocation(ctx, a.location ?? undefined);
      return {
        podSecret: null,
        pod: {
          deliveryId: d.id,
          kind: 'delivery',
          method,
          otpVerified: method === 'otp',
          receivedByName: a.receivedByName,
          signature: a.signature ?? null,
          photoKeys: photos,
          ...loc,
          driverUid: uid,
          capturedAt: ctx.now.toISOString(),
        },
        assignmentUpdate: { status: 'completed', endedAt: ctx.now },
        delivery: {
          status: 'delivered',
          custodian: { type: 'none' },
          openException: null,
          legs: updateLeg(d.legs, d.currentLegId, { status: 'completed' }),
        },
        events: [
          // Public message carries no names; the receiver is in the POD record and internal note.
          event(ctx, 'delivered', PUBLIC_STATUS_LABELS.delivered, actor, {
            ...at,
            internalNote: `Received by ${a.receivedByName} (${method})${loc.flaggedFarFromDestination ? `; POD captured ${loc.distanceFromDestinationM} m from destination` : ''}`,
          }),
        ],
        notifications: [sms(d.sender.phone, 'delivered', d.trackingNumber, `${deps.site.companyName}: ${d.trackingNumber} was delivered to ${a.receivedByName}.`)],
        audit: [...audit, ...(loc.flaggedFarFromDestination ? [{ actorUid: uid, actorRole: 'driver' as const, action: 'pod.far_from_destination', targetType: 'delivery', targetId: d.id, after: { meters: loc.distanceFromDestinationM } }] : [])],
      };
    }
    case 'report_delivery_failed': {
      ensureTransition(d.status, 'delivery_failed');
      const photos = a.photoKeys ?? [];
      if (photos.some((k) => !deps.verifiedPhotoKeys.includes(k))) throw new AppError('UPLOAD_NOT_FOUND', 'A photo has not finished uploading. Try again.');
      return {
        delivery: { status: 'delivery_failed', ...exception(ctx, a.reason, a.note, uid, 'delivery') },
        events: [event(ctx, 'delivery_failed', PUBLIC_STATUS_LABELS.delivery_failed, actor, { ...at, internalNote: `${a.reason}${a.note ? `: ${a.note}` : ''}` })],
        notifications: [sms(d.recipient.phone, 'delivery_failed', d.trackingNumber, `${deps.site.companyName}: we could not deliver ${d.trackingNumber} today. We will contact you to arrange another attempt.`)],
        audit,
      };
    }
    case 'complete_return': {
      ensureTransition(d.status, 'returned');
      const photos = a.photoKeys ?? [];
      if (photos.some((k) => !deps.verifiedPhotoKeys.includes(k))) throw new AppError('UPLOAD_NOT_FOUND', 'A photo has not finished uploading. Try again.');
      const loc = podLocation(ctx, a.location ?? undefined);
      return {
        pod: {
          deliveryId: d.id,
          kind: 'return',
          method: 'signature',
          otpVerified: false,
          receivedByName: a.receivedByName,
          signature: a.signature,
          photoKeys: photos,
          ...loc,
          driverUid: uid,
          capturedAt: ctx.now.toISOString(),
        },
        assignmentUpdate: { status: 'completed', endedAt: ctx.now },
        delivery: { status: 'returned', custodian: { type: 'none' }, legs: updateLeg(d.legs, d.currentLegId, { status: 'completed' }) },
        events: [event(ctx, 'returned', PUBLIC_STATUS_LABELS.returned, actor, at)],
        audit,
      };
    }
  }
}
