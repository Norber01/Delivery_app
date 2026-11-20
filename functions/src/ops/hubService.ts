import type { Role } from '@courier/constants';
import type { HubDoc, ManifestDoc, RouteDoc } from '@courier/shared-types';
import {
  createManifestSchema,
  hubScanSchema,
  hubSchema,
  issuesToFieldErrors,
  manifestActionSchema,
  manifestParcelSchema,
  routeSchema,
} from '@courier/validation';
import { requireRole, type Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import { decideAddToManifest, decideHubHandover, decideHubReceive, decideManifestAction, decideRemoveFromManifest } from './hubDecisions.js';
import type { OpsDeps } from './opsService.js';

export const HUB_ROLES: Role[] = ['hub_operator', 'dispatcher', 'manager', 'admin', 'super_admin'];
const NETWORK_ROLES: Role[] = ['manager', 'admin', 'super_admin'];

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: import('zod').ZodError } }, raw: unknown, msg = 'Invalid request.'): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new AppError('VALIDATION_FAILED', msg, 'invalid-argument', issuesToFieldErrors(r.error));
  return r.data;
}

/** Hub operators may act only at hubs in their `hubIds` claim; dispatchers/admins at any hub. */
export function requireHubAccess(caller: Caller, hubId: string): asserts caller is Caller & { uid: string; role: Role } {
  requireRole(caller, HUB_ROLES);
  if (caller.role === 'hub_operator' && !caller.hubIds?.includes(hubId)) {
    throw new AppError('PERMISSION_DENIED', 'You are not assigned to this hub.', 'permission-denied');
  }
}

const actor = (c: Caller & { uid: string; role: Role }) => ({ uid: c.uid, role: c.role });

// ---- Network administration -----------------------------------------------------------------

export async function upsertHub(deps: Pick<OpsDeps, 'ops'>, caller: Caller, raw: unknown): Promise<{ id: string }> {
  requireRole(caller, NETWORK_ROLES);
  const h = parse(hubSchema, raw, 'Check the hub details.');
  const hub: HubDoc = { ...h, phone: h.phone ?? null };
  await deps.ops.upsertHub(hub);
  return { id: hub.id };
}

export async function upsertRoute(deps: Pick<OpsDeps, 'ops'>, caller: Caller, raw: unknown): Promise<{ id: string }> {
  requireRole(caller, NETWORK_ROLES);
  const r = parse(routeSchema, raw, 'Check the route details.');
  const [o, d] = await Promise.all([deps.ops.getHub(r.originHubId), deps.ops.getHub(r.destinationHubId)]);
  if (!o || !d) throw new AppError('NOT_FOUND', 'Both hubs must exist before creating a route.', 'not-found');
  if (o.serviceAreaId === d.serviceAreaId) throw new AppError('VALIDATION_FAILED', 'A route must connect hubs in different service areas.', 'invalid-argument');
  const route: RouteDoc = { ...r, originAreaId: o.serviceAreaId, destinationAreaId: d.serviceAreaId };
  await deps.ops.upsertRoute(route);
  return { id: route.id };
}

// ---- Hub scans --------------------------------------------------------------------------------

/** Receive a parcel into the hub, or hand it to its assigned last-mile driver. */
export async function hubScan(deps: OpsDeps, caller: Caller, raw: unknown) {
  const s = parse(hubScanSchema, raw, 'Check the tracking number.');
  requireHubAccess(caller, s.hubId);
  const current = await deps.ops.getDelivery(s.trackingNumber);
  if (!current) throw new AppError('DELIVERY_NOT_FOUND', 'No delivery with this tracking number.', 'not-found');
  const outcome = await deps.ops.runDeliveryTx(
    s.trackingNumber,
    // Handover needs the assigned driver's profile (shift check).
    s.type === 'handover' && current.currentDriverUid ? { driverUid: current.currentDriverUid } : {},
    (ctx) => (s.type === 'receive' ? decideHubReceive(ctx, s.hubId, actor(caller)) : decideHubHandover(ctx, s.hubId, actor(caller), deps)),
  );
  if (outcome.kind !== 'applied') throw new AppError('DELIVERY_NOT_FOUND', 'No delivery with this tracking number.', 'not-found');
  return { trackingNumber: s.trackingNumber, status: outcome.delivery.status, destination: outcome.delivery.destinationHub?.city ?? outcome.delivery.destination.city };
}

// ---- Manifests -----------------------------------------------------------------------------------

export async function createManifest(deps: OpsDeps, caller: Caller, raw: unknown): Promise<{ id: string; number: string }> {
  const input = parse(createManifestSchema, raw, 'Check the manifest details.');
  const route = await deps.ops.getRoute(input.routeId);
  if (!route || !route.active) throw new AppError('NOT_FOUND', 'Route not found.', 'not-found');
  requireHubAccess(caller, route.originHubId);
  const [vehicle, driver] = await Promise.all([deps.ops.getVehicle(input.vehicleId), deps.ops.getDriver(input.driverUid)]);
  if (!vehicle || vehicle.status === 'maintenance' || vehicle.status === 'retired') throw new AppError('VEHICLE_UNAVAILABLE', 'This vehicle is not available.');
  if (!driver || driver.status !== 'active') throw new AppError('DRIVER_UNAVAILABLE', 'This driver is not active.');
  const dep = new Date(input.scheduledDepartureAt);
  const stamp = dep.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const m: ManifestDoc = {
    id: `mf_${deps.newId()}`,
    number: `${route.code}-${stamp.slice(0, 8)}-${stamp.slice(8)}`,
    routeId: route.id,
    routeCode: route.code,
    originHubId: route.originHubId,
    destinationHubId: route.destinationHubId,
    vehicleId: vehicle.id,
    vehicleRegistration: vehicle.registrationNumber,
    capacityKg: vehicle.capacityKg,
    driverUid: driver.uid,
    driverName: driver.name,
    scheduledDepartureAt: dep.toISOString(),
    status: 'open',
    deliveryIds: [],
    totalWeightKg: 0,
    receivedIds: [],
    missingIds: [],
    departedAt: null,
    expectedArrivalAt: null,
    arrivedAt: null,
    closedAt: null,
    createdBy: caller.uid,
  };
  await deps.ops.createManifest(m);
  return { id: m.id, number: m.number };
}

async function manifestFor(deps: OpsDeps, id: string) {
  const m = await deps.ops.getManifest(id);
  if (!m) throw new AppError('NOT_FOUND', 'Manifest not found.', 'not-found');
  return m;
}

export async function manifestParcel(deps: OpsDeps, caller: Caller, raw: unknown, op: 'add' | 'remove') {
  const p = parse(manifestParcelSchema, raw, 'Check the tracking number.');
  const m = await manifestFor(deps, p.manifestId);
  requireHubAccess(caller, m.originHubId);
  const updated = await deps.ops.runManifestTx(m.id, [p.trackingNumber], (ctx) =>
    op === 'add' ? decideAddToManifest(ctx, p.trackingNumber, actor(caller)) : decideRemoveFromManifest(ctx, p.trackingNumber, actor(caller)),
  );
  return { manifestId: m.id, parcels: updated?.deliveryIds.length ?? 0, totalWeightKg: updated?.totalWeightKg ?? 0 };
}

export async function manifestAction(deps: OpsDeps, caller: Caller, raw: unknown) {
  const a = parse(manifestActionSchema, raw);
  const m = await manifestFor(deps, a.manifestId);
  // Departure is controlled at the origin hub; arrival and closing at the destination hub.
  requireHubAccess(caller, a.action === 'arrive' || a.action === 'close' ? m.destinationHubId : m.originHubId);
  const updated = await deps.ops.runManifestTx(m.id, a.action === 'depart' || a.action === 'close' ? 'all' : [], (ctx) => decideManifestAction(ctx, a.action, actor(caller)));
  return { manifestId: m.id, status: updated?.status ?? m.status, missing: updated?.missingIds ?? [] };
}
