import type { BookingStatus, PaymentStatus } from '@courier/constants';
import type {
  AssignmentDoc,
  DeliveryDoc,
  DriverDoc,
  DriverLocation,
  HubDoc,
  HubRef,
  ManifestDoc,
  ProofOfDeliveryDoc,
  RouteDoc,
  VehicleDoc,
} from '@courier/shared-types';
import type { AppError } from '../lib/errors.js';
import type { AuditEntry, BookingRecord, NewNotification, PaymentRecord, TrackingEventRecord } from '../store/types.js';

export interface DeliveryRecord extends DeliveryDoc {
  /** Every driver who has held this delivery (driver read access + history). */
  driverUids: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface AssignmentRecord extends AssignmentDoc {
  createdAt: Date;
  startedAt: Date | null;
  endedAt: Date | null;
}

export interface PodSecret {
  deliveryId: string;
  otpHash: string;
  attempts: number;
  locked: boolean;
  expiresAt: Date;
}

export interface OpsContext {
  delivery: DeliveryRecord;
  booking: BookingRecord;
  assignment: AssignmentRecord | null;
  podSecret: PodSecret | null;
  /** Acting driver (driver actions) or target driver (assign). */
  driver: DriverDoc | null;
  /** Manifest of the current linehaul leg, if any. */
  manifest: ManifestDoc | null;
  now: Date;
}

/** Resolved intercity network for an origin/destination service-area pair. */
export interface NetworkRoute {
  route: RouteDoc;
  originHub: HubRef;
  destinationHub: HubRef;
}

export interface ManifestContext {
  manifest: ManifestDoc;
  deliveries: DeliveryRecord[];
  driver: DriverDoc | null;
  route: RouteDoc | null;
  now: Date;
}

export interface ManifestMutation {
  manifest?: Partial<ManifestDoc>;
  deliveries?: { id: string; patch: Partial<DeliveryRecord> }[];
  events?: TrackingEventRecord[];
  audit?: AuditEntry[];
}

/** Writes computed by a pure decision and applied atomically by the store. */
export interface OpsMutation {
  delivery?: Partial<DeliveryRecord>;
  /** Driver uid to add to `driverUids`. */
  addDriverUid?: string;
  booking?: { status?: BookingStatus; paymentStatus?: PaymentStatus };
  assignmentCreate?: AssignmentRecord;
  assignmentUpdate?: Partial<AssignmentRecord>;
  /** `null` deletes the secret. */
  podSecret?: PodSecret | null;
  pod?: ProofOfDeliveryDoc;
  payment?: PaymentRecord;
  events?: TrackingEventRecord[];
  notifications?: NewNotification[];
  audit?: AuditEntry[];
  /** Commit the writes above, then report this error to the caller (e.g. a counted wrong OTP). */
  fail?: AppError;
  /** Mark the delivery as received on its manifest (linehaul arrival scan). */
  manifestReceived?: string;
  /** Release reserved business credit (cancelled before invoicing). */
  creditRelease?: { businessId: string; amountPesewas: number };
}

export interface DriverActionRecord {
  actionId: string;
  driverUid: string;
  deliveryId: string;
  type: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
}

export type OpsOutcome =
  | { kind: 'applied'; delivery: DeliveryRecord }
  | { kind: 'duplicate'; previous: DriverActionRecord }
  | { kind: 'not_found' };

export interface OpsStore {
  getDelivery(id: string): Promise<DeliveryRecord | null>;
  /** Creates the delivery and links the booking, unless one already exists (idempotent). */
  createDelivery(delivery: DeliveryRecord): Promise<'created' | 'exists'>;
  /**
   * One transaction: dedupe on `action` (driver actions), read delivery + booking + current
   * assignment + POD secret + `driverUid`'s profile, decide, write.
   */
  runDeliveryTx(
    deliveryId: string,
    opts: { driverUid?: string; action?: { actionId: string; driverUid: string; type: string } },
    decide: (ctx: OpsContext) => OpsMutation,
  ): Promise<OpsOutcome>;

  getDriver(uid: string): Promise<DriverDoc | null>;
  createDriver(d: DriverDoc): Promise<void>;
  getVehicle(id: string): Promise<VehicleDoc | null>;
  upsertVehicle(v: VehicleDoc): Promise<void>;
  /** Start (or resume the same) shift atomically; returns the shift or a refusal. */
  startShift(uid: string, vehicleId: string, makeShift: (d: DriverDoc, v: VehicleDoc) => DriverDoc['currentShift']): Promise<
    { ok: true; shift: NonNullable<DriverDoc['currentShift']> } | { ok: false; code: 'SHIFT_ACTIVE' | 'VEHICLE_UNAVAILABLE' | 'DRIVER_UNAVAILABLE' | 'VEHICLE_TOO_SMALL' }
  >;
  /** Ends the shift unless the driver still holds packages or a departed manifest; frees the vehicle. */
  endShift(uid: string): Promise<'ended' | 'no_shift' | 'holding_packages'>;

  // ---- Network & manifests (Phase 4) ----
  getHub(id: string): Promise<HubDoc | null>;
  upsertHub(h: HubDoc): Promise<void>;
  getRoute(id: string): Promise<RouteDoc | null>;
  upsertRoute(r: RouteDoc): Promise<void>;
  /** Primary hubs of both areas and the active route between them, or null. */
  findNetworkRoute(originAreaId: string, destinationAreaId: string): Promise<NetworkRoute | null>;
  createManifest(m: ManifestDoc): Promise<void>;
  getManifest(id: string): Promise<ManifestDoc | null>;
  /**
   * One transaction over a manifest and the given deliveries ('all' = every delivery on it),
   * plus its route and driver.
   */
  runManifestTx(manifestId: string, deliveryIds: string[] | 'all', decide: (ctx: ManifestContext) => ManifestMutation): Promise<ManifestDoc | null>;

  listOverdueDeliveries(now: Date, limit: number): Promise<DeliveryRecord[]>;
  markDelayed(ids: string[]): Promise<void>;
  setEta(deliveryId: string, eta: DeliveryRecord['eta']): Promise<void>;

  createUploadTicket(t: { key: string; deliveryId: string; driverUid: string; contentType: string; maxBytes: number; expiresAt: Date }): Promise<void>;
  getUploadTicket(key: string): Promise<{ deliveryId: string; driverUid: string } | null>;
}

/** Realtime Database: shift authorisation and live locations (docs/06). */
export interface LivePort {
  setShift(uid: string, shift: { shiftId: string; activeUntilMs: number }): Promise<void>;
  clearShift(uid: string): Promise<void>;
  getDriverLocation(uid: string): Promise<DriverLocation | null>;
}

/** Confirms an uploaded evidence object exists in R2 (via the edge Worker). */
export interface EvidenceStore {
  exists(key: string): Promise<boolean>;
}
