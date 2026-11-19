import type {
  ManifestStatus,
  AssignmentStatus,
  DeliveryStatus,
  DeliveryType,
  DispatchActionType,
  DriverActionType,
  DriverStatus,
  ExceptionReason,
  LegStatus,
  LegType,
  PaymentPreference,
  PodMethod,
  SpecialHandling,
  Urgency,
  VehicleClass,
  VehicleStatus,
} from '@courier/constants';
import type { Address, Contact, IsoDateString, LatLng, PackageInfo } from './common.js';

export interface ShipmentLeg {
  id: string;
  sequence: number;
  type: LegType;
  status: LegStatus;
  assignmentId: string | null;
  driverUid: string | null;
  vehicleId: string | null;
  /** Linehaul legs: the manifest carrying the parcel. */
  manifestId?: string | null;
}

/** Denormalised hub details carried on intercity deliveries. */
export interface HubRef {
  id: string;
  code: string;
  name: string;
  city: string;
  location: LatLng;
}

/** `manifests/{id}`: one linehaul departure of one vehicle on one route. */
export interface ManifestDoc {
  id: string;
  /** Human-readable number, e.g. ACC-KSI-20261116-1800. */
  number: string;
  routeId: string;
  routeCode: string;
  originHubId: string;
  destinationHubId: string;
  vehicleId: string;
  vehicleRegistration: string;
  capacityKg: number;
  driverUid: string;
  driverName: string;
  scheduledDepartureAt: IsoDateString;
  status: ManifestStatus;
  deliveryIds: string[];
  totalWeightKg: number;
  receivedIds: string[];
  missingIds: string[];
  departedAt: IsoDateString | null;
  expectedArrivalAt: IsoDateString | null;
  arrivedAt: IsoDateString | null;
  closedAt: IsoDateString | null;
  createdBy: string;
}

export type Custodian = { type: 'none' } | { type: 'driver'; id: string } | { type: 'hub'; id: string } | { type: 'vehicle'; id: string };

export interface DeliveryException {
  reason: ExceptionReason;
  note: string | null;
  at: IsoDateString;
  byUid: string;
  stage: 'pickup' | 'delivery';
}

/**
 * `deliveries/{trackingNumber}`. Operational record created when a booking is confirmed.
 * Carries what drivers and dispatch need, so neither has to read the booking.
 */
export interface DeliveryDoc {
  id: string;
  trackingNumber: string;
  deliveryType: DeliveryType;
  urgency: Urgency;
  status: DeliveryStatus;
  /** Status before `on_hold`, restored on release. */
  heldFrom: DeliveryStatus | null;
  holdReason: string | null;
  /** Pickup service area (first mile / direct dispatch). */
  serviceAreaId: string;
  /** Destination service area (last-mile dispatch), null when outside any area. */
  destinationAreaId: string | null;
  requiredVehicleClass: VehicleClass | null;
  sender: Contact;
  recipient: Contact;
  pickup: Address;
  destination: Address;
  packages: PackageInfo[];
  specialHandling: SpecialHandling[];
  instructions: string | null;
  paymentPreference: PaymentPreference;
  /** Amount the driver must collect at pickup (cash bookings not yet paid), else 0. */
  collectOnPickupPesewas: number;
  /** From the confirmed price; used for manifest capacity. */
  chargeableWeightKg: number;
  /** Intercity only: hubs and route resolved at creation from the operational network. */
  originHub: HubRef | null;
  destinationHub: HubRef | null;
  routeId: string | null;
  /** Intercity: current linehaul (set on departure). */
  linehaul: { manifestId: string; departedAt: IsoDateString; expectedArrivalAt: IsoDateString } | null;
  legs: ShipmentLeg[];
  currentLegId: string | null;
  currentAssignmentId: string | null;
  currentDriverUid: string | null;
  custodian: Custodian;
  exceptions: DeliveryException[];
  /** Latest open exception reason, for the dispatch board. */
  openException: ExceptionReason | null;
  expectedDeliveryAt: IsoDateString;
  delayed: boolean;
  attempts: number;
  eta: { minutes: number; computedAt: IsoDateString } | null;
}

export interface AssignmentDoc {
  id: string;
  deliveryId: string;
  legId: string;
  driverUid: string;
  vehicleId: string;
  status: AssignmentStatus;
  assignedBy: string;
}

export interface VehicleDoc {
  id: string;
  registrationNumber: string;
  vehicleClass: VehicleClass;
  capacityKg: number;
  homeServiceAreaId: string;
  status: VehicleStatus;
  currentDriverUid: string | null;
  /** Phase 6: highest odometer reading recorded (shift start/end, fuel, service). */
  odometerKm?: number;
  /** Phase 6: service schedule and legal documents. */
  serviceIntervalKm?: number | null;
  serviceIntervalDays?: number | null;
  lastServiceAt?: IsoDateString | null;
  lastServiceKm?: number | null;
  insuranceExpiry?: IsoDateString | null;
  roadworthyExpiry?: IsoDateString | null;
}

export interface DriverShift {
  id: string;
  vehicleId: string;
  vehicleClass: VehicleClass;
  serviceAreaId: string;
  startedAt: IsoDateString;
  activeUntil: IsoDateString;
}

export interface DriverDoc {
  uid: string;
  name: string;
  phone: string;
  email: string;
  employeeNumber: string;
  homeServiceAreaId: string;
  status: DriverStatus;
  currentShift: DriverShift | null;
}

export interface DriverLocation extends LatLng {
  accuracyM: number;
  speedKph?: number;
  heading?: number;
  recordedAt: number;
  serverAt: number;
  shiftId: string;
  vehicleId?: string;
}

export type LocationFreshness = 'live' | 'delayed' | 'stale';

export interface LiveLocationView {
  lat: number;
  lng: number;
  updatedAt: IsoDateString;
  freshness: LocationFreshness;
  etaMinutes: number | null;
}

/** Vector signature: strokes of points normalised to 0..1 (small enough to store in Firestore). */
export type SignatureStrokes = [number, number][][];

export interface ProofOfDeliveryDoc {
  deliveryId: string;
  kind: 'delivery' | 'return';
  method: PodMethod;
  otpVerified: boolean;
  receivedByName: string;
  signature: SignatureStrokes | null;
  photoKeys: string[];
  location: LatLng | null;
  distanceFromDestinationM: number | null;
  flaggedFarFromDestination: boolean;
  driverUid: string;
  capturedAt: IsoDateString;
}

export interface DriverActionRequest {
  /** Client-generated id; replays of the same action are applied once. */
  actionId: string;
  type: DriverActionType;
  deliveryId: string;
  /** Device time the action happened (offline actions are replayed later). */
  occurredAt: IsoDateString;
  location?: LatLng | null;
  scannedCode?: string;
  cashCollected?: boolean;
  reason?: ExceptionReason;
  note?: string;
  otp?: string;
  receivedByName?: string;
  signature?: SignatureStrokes;
  photoKeys?: string[];
}

export interface DriverActionResponse {
  actionId: string;
  deliveryId: string;
  status: DeliveryStatus;
  duplicate: boolean;
}

export interface DispatchActionRequest {
  type: DispatchActionType;
  deliveryId: string;
  driverUid?: string;
  reason?: string;
}

export interface UploadTicket {
  key: string;
  uploadUrl: string;
  expiresAt: IsoDateString;
  maxBytes: number;
  contentType: string;
}

export type { DispatchActionType, DriverActionType };
