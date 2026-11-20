import { COLLECTIONS } from '@courier/constants';
import type { DriverDoc, DriverLocation, HubDoc, ManifestDoc, RouteDoc, VehicleDoc } from '@courier/shared-types';
import { evidenceUrl } from '@courier/shared-utils';
import type { Database } from 'firebase-admin/database';
import { FieldValue, Timestamp, type Firestore } from 'firebase-admin/firestore';
import { AppError } from '../lib/errors.js';
import { fromDoc, notificationDoc } from '../store/firestoreStore.js';
import type { BookingRecord } from '../store/types.js';
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
} from './types.js';

/** Statuses in which a driver is holding a package or has an open job. */
export const DRIVER_BUSY_STATUSES = ['assigned', 'en_route_to_pickup', 'picked_up', 'at_destination_hub', 'out_for_delivery', 'delivery_failed', 'returning_to_sender'];
const TERMINAL = ['delivered', 'returned', 'cancelled'];

export class FirestoreOpsStore implements OpsStore {
  /** `clock` is the transaction time (server time in production; the demo's sample data runs in the past). */
  constructor(
    private readonly db: Firestore,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private col(name: keyof typeof COLLECTIONS) {
    return this.db.collection(COLLECTIONS[name]);
  }

  async getDelivery(id: string): Promise<DeliveryRecord | null> {
    const s = await this.col('deliveries').doc(id).get();
    return s.exists ? fromDoc<DeliveryRecord>(s.data()!) : null;
  }

  async createDelivery(d: DeliveryRecord): Promise<'created' | 'exists'> {
    const ref = this.col('deliveries').doc(d.id);
    const bookingRef = this.col('deliveryRequests').doc(d.trackingNumber);
    return this.db.runTransaction(async (tx) => {
      const [existing, booking] = await Promise.all([tx.get(ref), tx.get(bookingRef)]);
      if (existing.exists || !booking.exists || booking.get('deliveryId')) return 'exists' as const;
      tx.create(ref, { ...d, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      tx.update(bookingRef, { deliveryId: d.id, updatedAt: FieldValue.serverTimestamp() });
      return 'created' as const;
    });
  }

  async runDeliveryTx(
    deliveryId: string,
    opts: { driverUid?: string; action?: { actionId: string; driverUid: string; type: string } },
    decide: (ctx: OpsContext) => OpsMutation,
  ): Promise<OpsOutcome> {
    const deliveryRef = this.col('deliveries').doc(deliveryId);
    const actionRef = opts.action ? this.col('driverActions').doc(opts.action.actionId) : null;
    const podRef = this.col('podSecrets').doc(deliveryId);
    const result = await this.db.runTransaction(async (tx) => {
      if (actionRef) {
        const prev = await tx.get(actionRef);
        if (prev.exists) return { outcome: { kind: 'duplicate', previous: prev.data() as DriverActionRecord } as OpsOutcome };
      }
      const dSnap = await tx.get(deliveryRef);
      if (!dSnap.exists) return { outcome: { kind: 'not_found' } as OpsOutcome };
      const delivery = fromDoc<DeliveryRecord>(dSnap.data()!);
      const bookingRef = this.col('deliveryRequests').doc(delivery.trackingNumber);
      const assignmentRef = delivery.currentAssignmentId ? this.col('assignments').doc(delivery.currentAssignmentId) : null;
      const driverRef = opts.driverUid ? this.col('drivers').doc(opts.driverUid) : null;
      const manifestId = delivery.legs.find((l) => l.id === delivery.currentLegId)?.manifestId ?? null;
      const manifestRef = manifestId ? this.col('manifests').doc(manifestId) : null;
      const [bSnap, aSnap, pSnap, drSnap, mSnap] = await Promise.all([
        tx.get(bookingRef),
        assignmentRef ? tx.get(assignmentRef) : null,
        tx.get(podRef),
        driverRef ? tx.get(driverRef) : null,
        manifestRef ? tx.get(manifestRef) : null,
      ]);
      const ctx: OpsContext = {
        delivery,
        booking: fromDoc<BookingRecord>(bSnap.data()!),
        assignment: aSnap?.exists ? fromDoc<AssignmentRecord>(aSnap.data()!) : null,
        podSecret: pSnap.exists ? fromDoc<PodSecret>(pSnap.data()!) : null,
        driver: drSnap?.exists ? (drSnap.data() as DriverDoc) : null,
        manifest: mSnap?.exists ? (mSnap.data() as ManifestDoc) : null,
        now: this.clock(),
      };
      const m = decide(ctx);
      if (m.manifestReceived && manifestRef) tx.update(manifestRef, { receivedIds: FieldValue.arrayUnion(m.manifestReceived) });

      if (m.delivery || m.addDriverUid) {
        tx.update(deliveryRef, {
          ...(m.delivery ?? {}),
          ...(m.addDriverUid ? { driverUids: FieldValue.arrayUnion(m.addDriverUid) } : {}),
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      if (m.booking) tx.update(bookingRef, { ...m.booking, updatedAt: FieldValue.serverTimestamp() });
      if (m.creditRelease) tx.update(this.col('sellers').doc(m.creditRelease.businessId), { creditUsedPesewas: FieldValue.increment(-m.creditRelease.amountPesewas) });
      if (m.assignmentCreate) tx.create(this.col('assignments').doc(m.assignmentCreate.id), m.assignmentCreate);
      if (m.assignmentUpdate && assignmentRef) tx.update(assignmentRef, m.assignmentUpdate);
      if (m.podSecret === null) tx.delete(podRef);
      else if (m.podSecret) tx.set(podRef, m.podSecret);
      if (m.pod) tx.set(this.col('proofOfDelivery').doc(m.pod.kind === 'return' ? `${deliveryId}_return` : deliveryId), m.pod);
      if (m.payment) {
        tx.create(this.col('payments').doc(m.payment.id), m.payment);
        // Cash a driver collects is owed to the company until handed in (Phase 6 cash ledger).
        if (m.payment.provider === 'cash' && m.payment.collectedBy) {
          tx.set(this.col('driverCash').doc(m.payment.collectedBy), { driverUid: m.payment.collectedBy, collectedPesewas: FieldValue.increment(m.payment.amountPesewas) }, { merge: true });
        }
      }
      for (const e of m.events ?? []) tx.create(this.col('trackingEvents').doc(), e);
      for (const n of m.notifications ?? []) tx.create(this.col('notifications').doc(), notificationDoc(n));
      for (const a of m.audit ?? []) tx.create(this.col('auditLogs').doc(), { ...a, at: FieldValue.serverTimestamp() });
      const status = m.delivery?.status ?? delivery.status;
      if (actionRef && opts.action) {
        const rec: DriverActionRecord = {
          ...opts.action,
          deliveryId,
          status,
          errorCode: m.fail?.code ?? null,
          errorMessage: m.fail?.message ?? null,
        };
        tx.create(actionRef, { ...rec, at: FieldValue.serverTimestamp() });
      }
      return { outcome: { kind: 'applied', delivery: { ...delivery, ...(m.delivery ?? {}) } } as OpsOutcome, fail: m.fail };
    });
    if (result.fail) throw result.fail;
    return result.outcome;
  }

  async getDriver(uid: string) {
    const s = await this.col('drivers').doc(uid).get();
    return s.exists ? (s.data() as DriverDoc) : null;
  }

  async createDriver(d: DriverDoc) {
    await this.col('drivers').doc(d.uid).create({ ...d, createdAt: FieldValue.serverTimestamp() });
  }

  async updateDriver(uid: string, patch: Partial<Pick<DriverDoc, 'riderType' | 'status'>>) {
    const ref = this.col('drivers').doc(uid);
    return this.db.runTransaction(async (tx) => {
      if (!(await tx.get(ref)).exists) return false;
      tx.update(ref, { ...patch, updatedAt: FieldValue.serverTimestamp() });
      return true;
    });
  }

  async getVehicle(id: string) {
    const s = await this.col('vehicles').doc(id).get();
    return s.exists ? (s.data() as VehicleDoc) : null;
  }

  async upsertVehicle(v: VehicleDoc) {
    await this.col('vehicles').doc(v.id).set({ ...v, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }

  async startShift(uid: string, vehicleId: string, makeShift: (d: DriverDoc, v: VehicleDoc) => DriverDoc['currentShift']) {
    const driverRef = this.col('drivers').doc(uid);
    const vehicleRef = this.col('vehicles').doc(vehicleId);
    return this.db.runTransaction(async (tx) => {
      const [dSnap, vSnap] = await Promise.all([tx.get(driverRef), tx.get(vehicleRef)]);
      const driver = dSnap.data() as DriverDoc | undefined;
      const vehicle = vSnap.data() as VehicleDoc | undefined;
      if (!driver || driver.status !== 'active') return { ok: false as const, code: 'DRIVER_UNAVAILABLE' as const };
      if (!vehicle) return { ok: false as const, code: 'VEHICLE_UNAVAILABLE' as const };
      const now = this.clock().getTime();
      const current = driver.currentShift;
      const active = current && new Date(current.activeUntil).getTime() > now;
      if (active && current.vehicleId === vehicleId) return { ok: true as const, shift: current };
      if (active) return { ok: false as const, code: 'SHIFT_ACTIVE' as const };
      const freeToTake = vehicle.status === 'available' || (vehicle.status === 'in_use' && vehicle.currentDriverUid === uid);
      if (!freeToTake) return { ok: false as const, code: 'VEHICLE_UNAVAILABLE' as const };
      // An expired shift on another vehicle: release that vehicle too.
      const oldVehicleRef = current && current.vehicleId !== vehicleId ? this.col('vehicles').doc(current.vehicleId) : null;
      const old = oldVehicleRef ? await tx.get(oldVehicleRef) : null;
      const shift = makeShift(driver, vehicle)!;
      tx.update(driverRef, { currentShift: shift });
      tx.update(vehicleRef, { status: 'in_use', currentDriverUid: uid });
      if (oldVehicleRef && old?.exists && old.get('currentDriverUid') === uid) tx.update(oldVehicleRef, { status: 'available', currentDriverUid: null });
      return { ok: true as const, shift };
    });
  }

  async endShift(uid: string) {
    const driverRef = this.col('drivers').doc(uid);
    return this.db.runTransaction(async (tx) => {
      const [dSnap, busy, linehaul] = await Promise.all([
        tx.get(driverRef),
        tx.get(this.col('deliveries').where('currentDriverUid', '==', uid).where('status', 'in', DRIVER_BUSY_STATUSES).limit(1)),
        tx.get(this.col('manifests').where('driverUid', '==', uid).where('status', '==', 'departed').limit(1)),
      ]);
      const shift = (dSnap.data() as DriverDoc | undefined)?.currentShift;
      if (!shift) return 'no_shift' as const;
      if (!busy.empty || !linehaul.empty) return 'holding_packages' as const;
      const vehicleRef = this.col('vehicles').doc(shift.vehicleId);
      const v = await tx.get(vehicleRef);
      tx.update(driverRef, { currentShift: null });
      if (v.exists && v.get('currentDriverUid') === uid) tx.update(vehicleRef, { status: 'available', currentDriverUid: null });
      return 'ended' as const;
    });
  }

  // ---- Network & manifests ----------------------------------------------------------

  async getHub(id: string) {
    const s = await this.col('hubs').doc(id).get();
    return s.exists ? (s.data() as HubDoc) : null;
  }
  async upsertHub(h: HubDoc) {
    await this.col('hubs').doc(h.id).set({ ...h, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  async getRoute(id: string) {
    const s = await this.col('routes').doc(id).get();
    return s.exists ? (s.data() as RouteDoc) : null;
  }
  async upsertRoute(r: RouteDoc) {
    await this.col('routes').doc(r.id).set({ ...r, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  async findWarehouse(areaId: string) {
    const s = await this.col('hubs').where('serviceAreaId', '==', areaId).where('primaryForArea', '==', true).where('active', '==', true).limit(1).get();
    if (s.empty) return null;
    const h = s.docs[0]!.data() as HubDoc;
    return { id: h.id, code: h.code, name: h.name, city: h.city, location: h.location };
  }
  async findNetworkRoute(originAreaId: string, destinationAreaId: string): Promise<NetworkRoute | null> {
    const primary = async (areaId: string) => {
      const s = await this.col('hubs').where('serviceAreaId', '==', areaId).where('primaryForArea', '==', true).where('active', '==', true).limit(1).get();
      return s.empty ? null : (s.docs[0]!.data() as HubDoc);
    };
    const [o, d] = await Promise.all([primary(originAreaId), primary(destinationAreaId)]);
    if (!o || !d) return null;
    const r = await this.col('routes').where('originHubId', '==', o.id).where('destinationHubId', '==', d.id).where('active', '==', true).limit(1).get();
    if (r.empty) return null;
    const ref = (h: HubDoc) => ({ id: h.id, code: h.code, name: h.name, city: h.city, location: h.location });
    return { route: r.docs[0]!.data() as RouteDoc, originHub: ref(o), destinationHub: ref(d) };
  }
  async createManifest(m: ManifestDoc) {
    await this.col('manifests').doc(m.id).create({ ...m, createdAt: FieldValue.serverTimestamp() });
  }
  async getManifest(id: string) {
    const s = await this.col('manifests').doc(id).get();
    return s.exists ? (s.data() as ManifestDoc) : null;
  }
  async runManifestTx(manifestId: string, deliveryIds: string[] | 'all', decide: (ctx: ManifestContext) => ManifestMutation) {
    const mRef = this.col('manifests').doc(manifestId);
    return this.db.runTransaction(async (tx) => {
      const mSnap = await tx.get(mRef);
      if (!mSnap.exists) return null;
      const manifest = mSnap.data() as ManifestDoc;
      const ids = deliveryIds === 'all' ? manifest.deliveryIds : deliveryIds;
      const [deliveries, driver, route] = await Promise.all([
        ids.length ? tx.getAll(...ids.map((id) => this.col('deliveries').doc(id))) : Promise.resolve([]),
        tx.get(this.col('drivers').doc(manifest.driverUid)),
        tx.get(this.col('routes').doc(manifest.routeId)),
      ]);
      const m = decide({
        manifest,
        deliveries: deliveries.filter((d) => d.exists).map((d) => fromDoc<DeliveryRecord>(d.data()!)),
        driver: driver.exists ? (driver.data() as DriverDoc) : null,
        route: route.exists ? (route.data() as RouteDoc) : null,
        now: this.clock(),
      });
      if (m.manifest) tx.update(mRef, { ...m.manifest, updatedAt: FieldValue.serverTimestamp() });
      for (const u of m.deliveries ?? []) tx.update(this.col('deliveries').doc(u.id), { ...u.patch, updatedAt: FieldValue.serverTimestamp() });
      for (const e of m.events ?? []) tx.create(this.col('trackingEvents').doc(), e);
      for (const a of m.audit ?? []) tx.create(this.col('auditLogs').doc(), { ...a, at: FieldValue.serverTimestamp() });
      return { ...manifest, ...(m.manifest ?? {}) };
    });
  }

  async listOverdueDeliveries(now: Date, limit: number) {
    const s = await this.col('deliveries').where('delayed', '==', false).where('expectedDeliveryAt', '<', now.toISOString()).limit(limit).get();
    return s.docs.map((d) => fromDoc<DeliveryRecord>(d.data())).filter((d) => !TERMINAL.includes(d.status));
  }

  async markDelayed(ids: string[]) {
    const batch = this.db.batch();
    for (const id of ids) batch.update(this.col('deliveries').doc(id), { delayed: true, updatedAt: FieldValue.serverTimestamp() });
    await batch.commit();
  }

  async setEta(id: string, eta: DeliveryRecord['eta']) {
    await this.col('deliveries').doc(id).update({ eta });
  }

  async createUploadTicket(t: { key: string; deliveryId: string; driverUid: string; contentType: string; maxBytes: number; expiresAt: Date }) {
    await this.col('uploads').doc(t.key.replace(/\//g, '__')).create({ ...t, expiresAt: Timestamp.fromDate(t.expiresAt) });
  }

  async getUploadTicket(key: string) {
    const s = await this.col('uploads').doc(key.replace(/\//g, '__')).get();
    return s.exists ? { deliveryId: s.get('deliveryId') as string, driverUid: s.get('driverUid') as string } : null;
  }
}

export class RtdbLive implements LivePort {
  constructor(private readonly rtdb: Database) {}
  async setShift(uid: string, s: { shiftId: string; activeUntilMs: number }) {
    await this.rtdb.ref(`shifts/${uid}`).set({ shiftId: s.shiftId, activeUntil: s.activeUntilMs });
  }
  async clearShift(uid: string) {
    await this.rtdb.ref().update({ [`shifts/${uid}`]: null, [`driverLocations/${uid}`]: null });
  }
  async getDriverLocation(uid: string) {
    const snap = await this.rtdb.ref(`driverLocations/${uid}`).get();
    return (snap.val() as DriverLocation | null) ?? null;
  }
}

/** Checks object existence through the Worker with a signed HEAD request. */
export class WorkerEvidenceStore implements EvidenceStore {
  constructor(
    private readonly workerUrl: string,
    private readonly secret: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}
  async exists(key: string) {
    const url = await evidenceUrl(this.workerUrl, this.secret, { method: 'HEAD', key, expires: Math.floor(Date.now() / 1000) + 60 });
    try {
      const res = await this.fetchImpl(url, { method: 'HEAD' });
      return res.status === 200;
    } catch {
      throw new AppError('UPLOAD_NOT_FOUND', 'Could not confirm the photo upload. Try again.', 'unavailable');
    }
  }
}
