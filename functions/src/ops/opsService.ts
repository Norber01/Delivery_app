import { TRACKING_DEFAULTS, type Role } from '@courier/constants';
import type { DriverActionResponse, DriverDoc, UploadTicket, VehicleDoc } from '@courier/shared-types';
import { evidenceUrl } from '@courier/shared-utils';
import {
  createDriverSchema,
  dispatchActionSchema,
  driverActionSchema,
  issuesToFieldErrors,
  startShiftSchema,
  uploadRequestSchema,
  vehicleSchema,
} from '@courier/validation';
import { requireRole, type Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import { randomId } from '../lib/hash.js';
import type { BookingRecord } from '../store/types.js';
import { buildDelivery, decideDispatch, decideDriverAction, type Site } from './decisions.js';
import type { EvidenceStore, LivePort, OpsStore } from './types.js';

export interface OpsDeps {
  ops: OpsStore;
  live: LivePort;
  evidence: EvidenceStore;
  now: () => Date;
  newId: () => string;
  newOtp: () => string;
  site: Site;
  uploads: { workerUrl: string; secret: string };
}

export const DISPATCH_ROLES: Role[] = ['dispatcher', 'admin', 'super_admin'];
export const FLEET_ROLES: Role[] = ['fleet_manager', 'admin', 'super_admin'];

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: import('zod').ZodError } }, raw: unknown, msg = 'Invalid request.'): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new AppError('VALIDATION_FAILED', msg, 'invalid-argument', issuesToFieldErrors(r.error));
  return r.data;
}

/** Called when a booking is written: create its delivery once it is confirmed (idempotent). */
export async function ensureDeliveryForBooking(deps: Pick<OpsDeps, 'ops' | 'now'>, booking: BookingRecord): Promise<'created' | 'exists' | 'not_ready'> {
  if (booking.status !== 'confirmed' || booking.deliveryId) return 'not_ready';
  // Intercity: resolve hubs and route now; if the network is not set up the delivery is still
  // created (hubs null) and dispatch is told to configure it before assigning.
  const network =
    booking.deliveryType === 'intercity' && booking.destinationAreaId
      ? await deps.ops.findNetworkRoute(booking.pickupAreaId, booking.destinationAreaId)
      : null;
  return deps.ops.createDelivery(buildDelivery(booking, deps.now(), network));
}

function checkScope(caller: Caller, serviceAreaId: string) {
  if (caller.serviceAreaIds && !caller.serviceAreaIds.includes(serviceAreaId)) {
    throw new AppError('PERMISSION_DENIED', 'This delivery is outside your service areas.', 'permission-denied');
  }
}

export async function dispatchAction(deps: OpsDeps, caller: Caller, raw: unknown) {
  requireRole(caller, DISPATCH_ROLES);
  const a = parse(dispatchActionSchema, raw);
  // Intercity deliveries created before their network existed: resolve hubs now.
  const before = await deps.ops.getDelivery(a.deliveryId);
  const network =
    a.type === 'assign' && before?.deliveryType === 'intercity' && !before.originHub && before.destinationAreaId
      ? await deps.ops.findNetworkRoute(before.serviceAreaId, before.destinationAreaId)
      : null;
  const outcome = await deps.ops.runDeliveryTx(a.deliveryId, { driverUid: a.driverUid }, (ctx) => {
    const isLastMile = ctx.delivery.legs.find((l) => l.id === ctx.delivery.currentLegId)?.type === 'last_mile';
    checkScope(caller, isLastMile && ctx.delivery.destinationAreaId ? ctx.delivery.destinationAreaId : ctx.delivery.serviceAreaId);
    if (network && !ctx.delivery.originHub) {
      ctx.delivery = { ...ctx.delivery, originHub: network.originHub, destinationHub: network.destinationHub, routeId: network.route.id };
      const m = decideDispatch(ctx, a, { actor: { uid: caller.uid, role: caller.role }, newId: deps.newId, newOtp: deps.newOtp, site: deps.site });
      return { ...m, delivery: { originHub: network.originHub, destinationHub: network.destinationHub, routeId: network.route.id, ...(m.delivery ?? {}) } };
    }
    return decideDispatch(ctx, a, { actor: { uid: caller.uid, role: caller.role }, newId: deps.newId, newOtp: deps.newOtp, site: deps.site });
  });
  if (outcome.kind === 'not_found') throw new AppError('DELIVERY_NOT_FOUND', 'Delivery not found.', 'not-found');
  if (outcome.kind === 'duplicate') throw new Error('unexpected duplicate');
  return { deliveryId: a.deliveryId, status: outcome.delivery.status };
}

/** Photo keys that exist in evidence storage and were issued to this driver for this delivery. */
async function verifyPhotos(deps: OpsDeps, keys: string[] | undefined, driverUid: string, deliveryId: string): Promise<string[]> {
  const ok: string[] = [];
  for (const key of keys ?? []) {
    const ticket = await deps.ops.getUploadTicket(key);
    if (ticket && ticket.driverUid === driverUid && ticket.deliveryId === deliveryId && (await deps.evidence.exists(key))) ok.push(key);
  }
  return ok;
}

/** A driver action from the app; safe to replay (same actionId → same result, applied once). */
export async function driverAction(deps: OpsDeps, caller: Caller, raw: unknown): Promise<DriverActionResponse> {
  requireRole(caller, ['driver']);
  const a = parse(driverActionSchema, raw);
  const photoKeys = 'photoKeys' in a ? a.photoKeys : undefined;
  const verifiedPhotoKeys = await verifyPhotos(deps, photoKeys, caller.uid, a.deliveryId);
  const outcome = await deps.ops.runDeliveryTx(
    a.deliveryId,
    { driverUid: caller.uid, action: { actionId: a.actionId, driverUid: caller.uid, type: a.type } },
    (ctx) => decideDriverAction(ctx, a, { driverUid: caller.uid, newOtp: deps.newOtp, site: deps.site, verifiedPhotoKeys }),
  );
  if (outcome.kind === 'not_found') throw new AppError('DELIVERY_NOT_FOUND', 'Delivery not found.', 'not-found');
  if (outcome.kind === 'duplicate') {
    const p = outcome.previous;
    if (p.driverUid !== caller.uid) throw new AppError('PERMISSION_DENIED', 'Invalid action.', 'permission-denied');
    // A replay must be the same action; an id reused for something else must never report success.
    if (p.deliveryId !== a.deliveryId || p.type !== a.type) {
      throw new AppError('VALIDATION_FAILED', 'This action id was already used for a different action. Please retry.', 'invalid-argument');
    }
    if (p.errorCode) throw new AppError(p.errorCode as never, p.errorMessage ?? 'Action failed.');
    return { actionId: a.actionId, deliveryId: a.deliveryId, status: p.status as DriverActionResponse['status'], duplicate: true };
  }
  return { actionId: a.actionId, deliveryId: a.deliveryId, status: outcome.delivery.status, duplicate: false };
}

// ---- Shifts -----------------------------------------------------------------------------------

export async function startShift(deps: OpsDeps, caller: Caller, raw: unknown): Promise<NonNullable<DriverDoc['currentShift']>> {
  requireRole(caller, ['driver']);
  const { vehicleId } = parse(startShiftSchema, raw);
  const now = deps.now();
  const res = await deps.ops.startShift(caller.uid, vehicleId, (driver, vehicle) => ({
    id: `sh_${deps.newId()}`,
    vehicleId: vehicle.id,
    vehicleClass: vehicle.vehicleClass,
    serviceAreaId: driver.homeServiceAreaId,
    startedAt: now.toISOString(),
    activeUntil: new Date(now.getTime() + TRACKING_DEFAULTS.maxShiftHours * 3600_000).toISOString(),
  }));
  if (!res.ok) {
    const messages = {
      SHIFT_ACTIVE: 'You already have a shift running on another vehicle. End it first.',
      VEHICLE_UNAVAILABLE: 'This vehicle is not available (in use, in maintenance or retired).',
      DRIVER_UNAVAILABLE: 'Your driver account is not active. Contact your supervisor.',
      VEHICLE_TOO_SMALL: 'This vehicle cannot be used.',
    } as const;
    throw new AppError(res.code, messages[res.code]);
  }
  // Authorise location writes (RTDB rules check this); safe to repeat if the app retries.
  await deps.live.setShift(caller.uid, { shiftId: res.shift.id, activeUntilMs: new Date(res.shift.activeUntil).getTime() });
  return res.shift;
}

export async function endShift(deps: OpsDeps, caller: Caller): Promise<{ ended: boolean }> {
  requireRole(caller, ['driver']);
  const r = await deps.ops.endShift(caller.uid);
  if (r === 'holding_packages') {
    throw new AppError('SHIFT_ACTIVE', 'You still have packages or active jobs. Complete them or contact dispatch before ending your shift.');
  }
  // Stop location sharing and delete the last position.
  await deps.live.clearShift(caller.uid);
  return { ended: r === 'ended' };
}

// ---- Fleet --------------------------------------------------------------------------------------

export interface DriverIdentityPort {
  /** Create a sign-in for the driver (no password) and return a set-password link. */
  createDriverUser(p: { email: string; phone: string; name: string }): Promise<{ uid: string; setupLink: string }>;
  setDriverClaims(uid: string): Promise<void>;
}

export async function createDriverAccount(deps: Pick<OpsDeps, 'ops'>, identity: DriverIdentityPort, caller: Caller, raw: unknown) {
  requireRole(caller, FLEET_ROLES);
  const input = parse(createDriverSchema, raw, 'Check the driver details.');
  const { uid, setupLink } = await identity.createDriverUser({ email: input.email, phone: input.phone, name: input.name });
  await identity.setDriverClaims(uid);
  await deps.ops.createDriver({ uid, ...input, status: 'active', currentShift: null });
  return { uid, setupLink };
}

export async function upsertVehicle(deps: Pick<OpsDeps, 'ops'>, caller: Caller, raw: unknown) {
  requireRole(caller, FLEET_ROLES);
  const input = parse(vehicleSchema, raw, 'Check the vehicle details.');
  const existing = input.id ? await deps.ops.getVehicle(input.id) : null;
  if (existing && existing.status === 'in_use' && input.status !== 'available') {
    throw new AppError('VEHICLE_UNAVAILABLE', 'This vehicle is on an active shift; end the shift before changing its status.');
  }
  const v: VehicleDoc = {
    id: input.id ?? `veh_${randomId(10)}`,
    registrationNumber: input.registrationNumber,
    vehicleClass: input.vehicleClass,
    capacityKg: input.capacityKg,
    homeServiceAreaId: input.homeServiceAreaId,
    status: existing?.status === 'in_use' ? 'in_use' : input.status,
    currentDriverUid: existing?.currentDriverUid ?? null,
  };
  await deps.ops.upsertVehicle(v);
  return { id: v.id };
}

// ---- Evidence uploads -----------------------------------------------------------------------

const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as const;

export async function requestUpload(deps: OpsDeps, caller: Caller, raw: unknown): Promise<UploadTicket> {
  requireRole(caller, ['driver']);
  const input = parse(uploadRequestSchema, raw);
  const delivery = await deps.ops.getDelivery(input.deliveryId);
  if (!delivery || delivery.currentDriverUid !== caller.uid) {
    throw new AppError('NOT_ASSIGNED_TO_YOU', 'This delivery is not assigned to you.', 'permission-denied');
  }
  const key = `pod/${delivery.id}/${randomId(20)}.${EXT[input.contentType]}`;
  const expires = Math.floor(deps.now().getTime() / 1000) + 15 * 60;
  await deps.ops.createUploadTicket({
    key,
    deliveryId: delivery.id,
    driverUid: caller.uid,
    contentType: input.contentType,
    maxBytes: input.bytes,
    expiresAt: new Date(expires * 1000),
  });
  return {
    key,
    uploadUrl: await evidenceUrl(deps.uploads.workerUrl, deps.uploads.secret, { method: 'PUT', key, expires, contentType: input.contentType, maxBytes: input.bytes }),
    expiresAt: new Date(expires * 1000).toISOString(),
    maxBytes: input.bytes,
    contentType: input.contentType,
  };
}

/** Short-lived view URL for a POD photo (ops staff only). */
export async function getEvidenceUrl(deps: OpsDeps, caller: Caller, raw: unknown): Promise<{ url: string }> {
  requireRole(caller, ['dispatcher', 'finance', 'admin', 'super_admin']);
  const key = typeof (raw as { key?: unknown })?.key === 'string' ? (raw as { key: string }).key : '';
  const pod = /^pod\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{8,64}\.(jpg|png|webp)$/.test(key);
  // Business registration documents are visible to admin/finance only.
  const kyb = /^kyb\/[A-Za-z0-9_-]{1,64}\/[A-Za-z0-9_-]{8,64}\.(jpg|png|webp|pdf)$/.test(key) && caller.role !== 'dispatcher';
  if (!pod && !kyb) throw new AppError('VALIDATION_FAILED', 'Invalid key.', 'invalid-argument');
  const expires = Math.floor(deps.now().getTime() / 1000) + 5 * 60;
  return { url: await evidenceUrl(deps.uploads.workerUrl, deps.uploads.secret, { method: 'GET', key, expires }) };
}

// ---- Delay detection -----------------------------------------------------------------------

export async function flagDelayedDeliveries(deps: Pick<OpsDeps, 'ops' | 'now'>, limit = 200) {
  const overdue = await deps.ops.listOverdueDeliveries(deps.now(), limit);
  const ids = overdue.filter((d) => !d.delayed).map((d) => d.id);
  if (ids.length) await deps.ops.markDelayed(ids);
  return { flagged: ids.length };
}
