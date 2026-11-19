import type { DriverDoc, DriverLocation, HubDoc, ManifestDoc, RouteDoc, VehicleDoc } from '@courier/shared-types';
import type {
  AssignmentRecord,
  DeliveryRecord,
  DriverActionRecord,
  EvidenceStore,
  LivePort,
  ManifestContext,
  ManifestMutation,
  NetworkRoute,
  OpsContext,
  OpsMutation,
  OpsOutcome,
  OpsStore,
  PodSecret,
} from '../src/ops/types.js';
import type { ProofOfDeliveryDoc } from '@courier/shared-types';
import type { MemoryStore } from './memoryStore.js';

const BUSY = ['assigned', 'en_route_to_pickup', 'picked_up', 'at_destination_hub', 'out_for_delivery', 'delivery_failed', 'returning_to_sender'];
const clone = <T>(v: T): T => structuredClone(v);

/** In-memory OpsStore sharing bookings/events/notifications/audit with a MemoryStore. */
export class MemoryOpsStore implements OpsStore {
  /** Phase 6 cash ledger (shared with the fleet memory store). */
  driverCash = new Map<string, { driverUid: string; collectedPesewas: number; remittedPesewas: number }>();
  deliveries = new Map<string, DeliveryRecord>();
  assignments = new Map<string, AssignmentRecord>();
  podSecrets = new Map<string, PodSecret>();
  pods = new Map<string, ProofOfDeliveryDoc>();
  drivers = new Map<string, DriverDoc>();
  vehicles = new Map<string, VehicleDoc>();
  actions = new Map<string, DriverActionRecord>();
  uploads = new Map<string, { deliveryId: string; driverUid: string }>();
  hubs = new Map<string, HubDoc>();
  routes = new Map<string, RouteDoc>();
  manifests = new Map<string, ManifestDoc>();

  constructor(
    private readonly store: MemoryStore,
    private readonly clock: { now: Date },
  ) {}

  async getDelivery(id: string) {
    const d = this.deliveries.get(id);
    return d ? clone(d) : null;
  }
  async createDelivery(d: DeliveryRecord) {
    const b = this.store.bookings.get(d.trackingNumber);
    if (this.deliveries.has(d.id) || !b || b.deliveryId) return 'exists' as const;
    this.deliveries.set(d.id, clone(d));
    b.deliveryId = d.id;
    return 'created' as const;
  }
  async runDeliveryTx(
    id: string,
    opts: { driverUid?: string; action?: { actionId: string; driverUid: string; type: string } },
    decide: (ctx: OpsContext) => OpsMutation,
  ): Promise<OpsOutcome> {
    if (opts.action && this.actions.has(opts.action.actionId)) return { kind: 'duplicate', previous: clone(this.actions.get(opts.action.actionId)!) };
    const d = this.deliveries.get(id);
    if (!d) return { kind: 'not_found' };
    const b = this.store.bookings.get(d.trackingNumber)!;
    const a = d.currentAssignmentId ? (this.assignments.get(d.currentAssignmentId) ?? null) : null;
    const manifestId = d.legs.find((l) => l.id === d.currentLegId)?.manifestId ?? null;
    const manifest = manifestId ? (this.manifests.get(manifestId) ?? null) : null;
    const ctx: OpsContext = {
      delivery: clone(d),
      booking: clone(b),
      assignment: a ? clone(a) : null,
      podSecret: this.podSecrets.has(id) ? clone(this.podSecrets.get(id)!) : null,
      driver: opts.driverUid && this.drivers.has(opts.driverUid) ? clone(this.drivers.get(opts.driverUid)!) : null,
      manifest: manifest ? clone(manifest) : null,
      now: this.clock.now,
    };
    const m = decide(ctx); // throws → nothing written (transaction aborted)
    if (m.manifestReceived && manifest && !manifest.receivedIds.includes(m.manifestReceived)) manifest.receivedIds.push(m.manifestReceived);
    if (m.delivery) Object.assign(d, clone(m.delivery));
    if (m.addDriverUid && !d.driverUids.includes(m.addDriverUid)) d.driverUids.push(m.addDriverUid);
    if (m.booking) Object.assign(b, m.booking);
    if (m.creditRelease) {
      const sd = this.store.sellers.get(m.creditRelease.businessId);
      if (sd) sd.creditUsedPesewas -= m.creditRelease.amountPesewas;
    }
    if (m.assignmentCreate) this.assignments.set(m.assignmentCreate.id, clone(m.assignmentCreate));
    if (m.assignmentUpdate && a) Object.assign(a, m.assignmentUpdate);
    if (m.podSecret === null) this.podSecrets.delete(id);
    else if (m.podSecret) this.podSecrets.set(id, clone(m.podSecret));
    if (m.pod) this.pods.set(m.pod.kind === 'return' ? `${id}_return` : id, clone(m.pod));
    if (m.payment) {
      this.store.payments.set(m.payment.id, clone(m.payment));
      if (m.payment.provider === 'cash' && m.payment.collectedBy) {
        const l = this.driverCash.get(m.payment.collectedBy) ?? { driverUid: m.payment.collectedBy, collectedPesewas: 0, remittedPesewas: 0 };
        l.collectedPesewas += m.payment.amountPesewas;
        this.driverCash.set(m.payment.collectedBy, l);
      }
    }
    this.store.events.push(...(m.events ?? []));
    for (const n of m.notifications ?? []) await this.store.queueNotification(n);
    this.store.audit.push(...(m.audit ?? []));
    if (opts.action) {
      this.actions.set(opts.action.actionId, { ...opts.action, deliveryId: id, status: d.status, errorCode: m.fail?.code ?? null, errorMessage: m.fail?.message ?? null });
    }
    if (m.fail) throw m.fail;
    return { kind: 'applied', delivery: clone(d) };
  }
  async getDriver(uid: string) {
    const d = this.drivers.get(uid);
    return d ? clone(d) : null;
  }
  async createDriver(d: DriverDoc) {
    this.drivers.set(d.uid, clone(d));
  }
  async getVehicle(id: string) {
    const v = this.vehicles.get(id);
    return v ? clone(v) : null;
  }
  async upsertVehicle(v: VehicleDoc) {
    this.vehicles.set(v.id, clone(v));
  }
  async startShift(uid: string, vehicleId: string, make: (d: DriverDoc, v: VehicleDoc) => DriverDoc['currentShift']) {
    const d = this.drivers.get(uid);
    const v = this.vehicles.get(vehicleId);
    if (!d || d.status !== 'active') return { ok: false as const, code: 'DRIVER_UNAVAILABLE' as const };
    if (!v) return { ok: false as const, code: 'VEHICLE_UNAVAILABLE' as const };
    const cur = d.currentShift;
    const active = cur && new Date(cur.activeUntil) > this.clock.now;
    if (active && cur.vehicleId === vehicleId) return { ok: true as const, shift: clone(cur) };
    if (active) return { ok: false as const, code: 'SHIFT_ACTIVE' as const };
    if (!(v.status === 'available' || (v.status === 'in_use' && v.currentDriverUid === uid))) return { ok: false as const, code: 'VEHICLE_UNAVAILABLE' as const };
    if (cur && cur.vehicleId !== vehicleId) {
      const old = this.vehicles.get(cur.vehicleId);
      if (old?.currentDriverUid === uid) Object.assign(old, { status: 'available', currentDriverUid: null });
    }
    const shift = make(d, v)!;
    d.currentShift = shift;
    Object.assign(v, { status: 'in_use', currentDriverUid: uid });
    return { ok: true as const, shift: clone(shift) };
  }
  async endShift(uid: string) {
    const d = this.drivers.get(uid);
    if (!d?.currentShift) return 'no_shift' as const;
    if ([...this.deliveries.values()].some((x) => x.currentDriverUid === uid && BUSY.includes(x.status))) return 'holding_packages' as const;
    if ([...this.manifests.values()].some((m) => m.driverUid === uid && m.status === 'departed')) return 'holding_packages' as const;
    const v = this.vehicles.get(d.currentShift.vehicleId);
    if (v?.currentDriverUid === uid) Object.assign(v, { status: 'available', currentDriverUid: null });
    d.currentShift = null;
    return 'ended' as const;
  }
  async getHub(id: string) {
    return this.hubs.has(id) ? clone(this.hubs.get(id)!) : null;
  }
  async upsertHub(h: HubDoc) {
    this.hubs.set(h.id, clone(h));
  }
  async getRoute(id: string) {
    return this.routes.has(id) ? clone(this.routes.get(id)!) : null;
  }
  async upsertRoute(r: RouteDoc) {
    this.routes.set(r.id, clone(r));
  }
  async findNetworkRoute(originAreaId: string, destinationAreaId: string): Promise<NetworkRoute | null> {
    const primary = (area: string) => [...this.hubs.values()].find((h) => h.serviceAreaId === area && h.primaryForArea && h.active);
    const o = primary(originAreaId);
    const d = primary(destinationAreaId);
    const r = o && d ? [...this.routes.values()].find((x) => x.originHubId === o.id && x.destinationHubId === d.id && x.active) : undefined;
    if (!o || !d || !r) return null;
    const ref = (h: HubDoc) => ({ id: h.id, code: h.code, name: h.name, city: h.city, location: h.location });
    return { route: clone(r), originHub: ref(o), destinationHub: ref(d) };
  }
  async createManifest(m: ManifestDoc) {
    this.manifests.set(m.id, clone(m));
  }
  async getManifest(id: string) {
    return this.manifests.has(id) ? clone(this.manifests.get(id)!) : null;
  }
  async runManifestTx(id: string, ids: string[] | 'all', decide: (ctx: ManifestContext) => ManifestMutation) {
    const m = this.manifests.get(id);
    if (!m) return null;
    const list = (ids === 'all' ? m.deliveryIds : ids).map((x) => this.deliveries.get(x)).filter((x): x is DeliveryRecord => !!x);
    const mut = decide({
      manifest: clone(m),
      deliveries: list.map(clone),
      driver: this.drivers.has(m.driverUid) ? clone(this.drivers.get(m.driverUid)!) : null,
      route: this.routes.has(m.routeId) ? clone(this.routes.get(m.routeId)!) : null,
      now: this.clock.now,
    });
    if (mut.manifest) Object.assign(m, clone(mut.manifest));
    for (const u of mut.deliveries ?? []) Object.assign(this.deliveries.get(u.id)!, clone(u.patch));
    this.store.events.push(...(mut.events ?? []));
    this.store.audit.push(...(mut.audit ?? []));
    return clone(m);
  }
  async listOverdueDeliveries(now: Date) {
    return [...this.deliveries.values()].filter((d) => !d.delayed && d.expectedDeliveryAt < now.toISOString() && !['delivered', 'returned', 'cancelled'].includes(d.status)).map(clone);
  }
  async markDelayed(ids: string[]) {
    for (const id of ids) this.deliveries.get(id)!.delayed = true;
  }
  async setEta(id: string, eta: DeliveryRecord['eta']) {
    this.deliveries.get(id)!.eta = eta;
  }
  async createUploadTicket(t: { key: string; deliveryId: string; driverUid: string }) {
    this.uploads.set(t.key, { deliveryId: t.deliveryId, driverUid: t.driverUid });
  }
  async getUploadTicket(key: string) {
    return this.uploads.get(key) ?? null;
  }
}

export class MemoryLive implements LivePort {
  shifts = new Map<string, { shiftId: string; activeUntilMs: number }>();
  locations = new Map<string, DriverLocation>();
  async setShift(uid: string, s: { shiftId: string; activeUntilMs: number }) {
    this.shifts.set(uid, s);
  }
  async clearShift(uid: string) {
    this.shifts.delete(uid);
    this.locations.delete(uid);
  }
  async getDriverLocation(uid: string) {
    return this.locations.get(uid) ?? null;
  }
}

export class MemoryEvidence implements EvidenceStore {
  objects = new Set<string>();
  async exists(key: string) {
    return this.objects.has(key);
  }
}
