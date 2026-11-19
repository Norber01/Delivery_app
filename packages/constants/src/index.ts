/** Shared constants. Every value here is part of the data contract between apps, functions and rules. */

export const CURRENCY = 'GHS' as const;

export const ROLES = [
  'customer',
  'business_owner',
  'business_staff',
  'driver',
  'hub_operator',
  'dispatcher',
  'fleet_manager',
  'finance',
  'admin',
  'super_admin',
] as const;
export type Role = (typeof ROLES)[number];

/** Roles that operate internal tools and must have MFA enrolled. */
export const STAFF_ROLES = [
  'hub_operator',
  'dispatcher',
  'fleet_manager',
  'finance',
  'admin',
  'super_admin',
] as const satisfies readonly Role[];
export type StaffRole = (typeof STAFF_ROLES)[number];

/** Roles an `admin` may grant. Only `super_admin` may grant `admin`/`super_admin`. */
export const ADMIN_GRANTABLE_ROLES = [
  'customer',
  'business_owner',
  'business_staff',
  'driver',
  'hub_operator',
  'dispatcher',
  'fleet_manager',
  'finance',
] as const satisfies readonly Role[];

export const DELIVERY_TYPES = ['intra_city', 'intercity', 'long_distance'] as const;
export type DeliveryType = (typeof DELIVERY_TYPES)[number];

export const URGENCY_LEVELS = ['standard', 'express', 'same_day'] as const;
export type Urgency = (typeof URGENCY_LEVELS)[number];

export const SPECIAL_HANDLING = ['fragile', 'perishable', 'high_value', 'documents', 'liquid'] as const;
export type SpecialHandling = (typeof SPECIAL_HANDLING)[number];

/** Ordered smallest → largest. Vehicle selection picks the first that fits. */
export const VEHICLE_CLASSES = ['motorbike', 'car', 'van', 'truck'] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number];

export const PAYMENT_PREFERENCES = ['mobile_money', 'card', 'cash_on_pickup', 'business_invoice'] as const;
export type PaymentPreference = (typeof PAYMENT_PREFERENCES)[number];

export const BOOKING_STATUSES = ['pending_payment', 'confirmed', 'cancelled'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const PAYMENT_STATUSES = [
  'unpaid',
  'pending',
  'paid',
  'refunded',
  'partially_refunded',
  'invoiced',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export const DELIVERY_STATUSES = [
  'awaiting_assignment',
  'assigned',
  'en_route_to_pickup',
  'pickup_failed',
  'picked_up',
  'at_origin_hub',
  'in_transit',
  'at_destination_hub',
  'out_for_delivery',
  'delivery_failed',
  'returning_to_sender',
  'on_hold',
  'delivered',
  'returned',
  'cancelled',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const TERMINAL_DELIVERY_STATUSES = ['delivered', 'returned', 'cancelled'] as const satisfies readonly DeliveryStatus[];

export const ASSIGNMENT_STATUSES = ['assigned', 'started', 'completed', 'failed', 'cancelled'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const LEG_TYPES = ['direct', 'first_mile', 'linehaul', 'last_mile'] as const;
export type LegType = (typeof LEG_TYPES)[number];

export const LEG_STATUSES = ['planned', 'assigned', 'in_progress', 'completed', 'failed', 'cancelled'] as const;
export type LegStatus = (typeof LEG_STATUSES)[number];

export const VEHICLE_STATUSES = ['available', 'in_use', 'maintenance', 'retired'] as const;
export type VehicleStatus = (typeof VEHICLE_STATUSES)[number];

export const DRIVER_STATUSES = ['active', 'suspended'] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

export const EXCEPTION_REASONS = [
  'recipient_unavailable',
  'sender_unavailable',
  'wrong_address',
  'refused',
  'damaged',
  'access_denied',
  'weather',
  'vehicle_breakdown',
  'package_not_ready',
  'missing_in_transit',
  'other',
] as const;
export type ExceptionReason = (typeof EXCEPTION_REASONS)[number];

/** Reasons a driver can report (system-detected reasons such as missing_in_transit are excluded). */
export const DRIVER_EXCEPTION_REASONS = EXCEPTION_REASONS.filter((r) => r !== 'missing_in_transit') as Exclude<ExceptionReason, 'missing_in_transit'>[];

export const POD_METHODS = ['otp', 'signature'] as const;
export type PodMethod = (typeof POD_METHODS)[number];

/** Driver actions submitted from the driver app (possibly replayed from the offline queue). */
export const DRIVER_ACTIONS = [
  'start_assignment',
  'confirm_pickup',
  'report_pickup_failed',
  'complete_delivery',
  'report_delivery_failed',
  'complete_return',
] as const;
export type DriverActionType = (typeof DRIVER_ACTIONS)[number];

/** Dispatcher actions on a delivery. */
export const DISPATCH_ACTIONS = ['assign', 'unassign', 'reschedule', 'reattempt', 'return_to_sender', 'cancel', 'hold', 'release'] as const;
export type DispatchActionType = (typeof DISPATCH_ACTIONS)[number];

/** GPS defaults (docs/06-gps-tracking.md §6.3); overridable via `config/tracking`. */
export const TRACKING_DEFAULTS = {
  intervalSeconds: 45,
  minIntervalSeconds: 30,
  maxIntervalSeconds: 60,
  minDistanceMeters: 100,
  stationaryIntervalSeconds: 180,
  stationarySpeedKph: 2,
  stationaryAfterSeconds: 300,
  maxAccuracyMeters: 100,
  /** Location is "live" while younger than 2 × interval, "delayed" up to this, then "stale". */
  staleAfterSeconds: 600,
  maxShiftHours: 12,
  etaRefreshSeconds: 300,
} as const;

export const HUB_TYPES = ['hub', 'warehouse', 'drop_point'] as const;
export type HubType = (typeof HUB_TYPES)[number];

/**
 * Linehaul manifest lifecycle: open (loading) → sealed (no more changes) → departed (on the
 * vehicle) → arrived (at destination hub, unloading) → closed (all parcels accounted for).
 */
export const MANIFEST_STATUSES = ['open', 'sealed', 'departed', 'arrived', 'closed'] as const;
export type ManifestStatus = (typeof MANIFEST_STATUSES)[number];

/** Max parcels per manifest (keeps a departure inside one Firestore transaction). */
export const MAX_MANIFEST_PARCELS = 150;

/** Hub scan operations performed by hub operators (USB/Bluetooth scanners type into a field). */
export const HUB_SCAN_TYPES = ['receive', 'handover'] as const;
export type HubScanType = (typeof HUB_SCAN_TYPES)[number];

export const BUSINESS_VERIFICATION_STATUSES = ['pending', 'verified', 'rejected', 'suspended'] as const;
export type BusinessVerificationStatus = (typeof BUSINESS_VERIFICATION_STATUSES)[number];

export const INVOICE_STATUSES = ['issued', 'partially_paid', 'paid', 'overdue', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const INVOICE_PAYMENT_METHODS = ['bank_transfer', 'mobile_money', 'cheque', 'cash'] as const;
export type InvoicePaymentMethod = (typeof INVOICE_PAYMENT_METHODS)[number];

/** Bulk booking limits (rows per CSV batch; batch previews expire). */
export const BULK = { maxRows: 200, previewTtlMinutes: 60, maxAddressBook: 2000, maxStaff: 50 } as const;
/** Max bookings per invoice document (larger months are split into parts). */
export const MAX_INVOICE_LINES = 400;

/** POD OTP rules. */
export const POD_OTP = { digits: 6, maxAttempts: 5, ttlHours: 48 } as const;
/** POD captured further than this from the destination is flagged for review. */
export const POD_DISTANCE_FLAG_METERS = 300;

/** Promised delivery windows used for `expectedDeliveryAt` and delay detection (hours from confirmation). */
export const DELIVERY_WINDOWS_HOURS = {
  intra_city: { standard: 48, express: 24, same_day: 10 },
  long_distance: { standard: 96, express: 72, same_day: 72 },
  intercity: { standard: 72, express: 48, same_day: 48 },
} as const;

/** Vehicle capability rank, used to check a driver's vehicle can carry a booking's vehicle class. */
export const VEHICLE_RANK: Record<VehicleClass, number> = { motorbike: 0, car: 1, van: 2, truck: 3 };

export const GHANA_REGIONS = [
  'Ahafo',
  'Ashanti',
  'Bono',
  'Bono East',
  'Central',
  'Eastern',
  'Greater Accra',
  'North East',
  'Northern',
  'Oti',
  'Savannah',
  'Upper East',
  'Upper West',
  'Volta',
  'Western',
  'Western North',
] as const;
export type GhanaRegion = (typeof GHANA_REGIONS)[number];

/** Approximate bounding box of Ghana, used to reject obviously wrong coordinates. */
export const GHANA_BOUNDS = { minLat: 4.5, maxLat: 11.3, minLng: -3.4, maxLng: 1.3 } as const;

/** Ghana mobile network prefixes (after the leading 0 / +233). */
export const GHANA_MOBILE_PREFIXES = ['20', '23', '24', '25', '26', '27', '28', '50', '53', '54', '55', '56', '57', '59'] as const;

/** Lifecycle of a single payment attempt (`payments/{id}.status`). */
export const PAYMENT_RECORD_STATUSES = ['initiated', 'pending', 'succeeded', 'failed', 'flagged', 'expired'] as const;
export type PaymentRecordStatus = (typeof PAYMENT_RECORD_STATUSES)[number];

export const REFUND_STATUSES = ['pending', 'processed', 'failed'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];

/** Payment preferences settled online through the payment provider. */
export const ONLINE_PAYMENT_PREFERENCES = ['mobile_money', 'card'] as const satisfies readonly PaymentPreference[];

export const QUOTE_TTL_MINUTES = 30;
/** Pending online payments are re-verified with the provider after this long. */
export const PAYMENT_RECONCILE_AFTER_MINUTES = 15;
/** Unpaid online attempts older than this are marked expired. */
export const PAYMENT_EXPIRE_AFTER_HOURS = 24;
export const FIREBASE_REGION = 'europe-west1';

export const COLLECTIONS = {
  users: 'users',
  customers: 'customers',
  sellers: 'sellers',
  drivers: 'drivers',
  staff: 'staff',
  vehicles: 'vehicles',
  hubs: 'hubs',
  serviceAreas: 'serviceAreas',
  routes: 'routes',
  pricingRules: 'pricingRules',
  contractPricing: 'contractPricing',
  config: 'config',
  quotes: 'quotes',
  deliveryRequests: 'deliveryRequests',
  deliveries: 'deliveries',
  shipmentLegs: 'shipmentLegs',
  assignments: 'assignments',
  manifests: 'manifests',
  trackingEvents: 'trackingEvents',
  deliveryRoutes: 'deliveryRoutes',
  payments: 'payments',
  paymentEvents: 'paymentEvents',
  refunds: 'refunds',
  invoices: 'invoices',
  proofOfDelivery: 'proofOfDelivery',
  notifications: 'notifications',
  supportTickets: 'supportTickets',
  expenses: 'expenses',
  auditLogs: 'auditLogs',
  rateLimits: 'rateLimits',
  podSecrets: 'podSecrets',
  driverActions: 'driverActions',
  uploads: 'uploads',
  bulkBatches: 'bulkBatches',
  counters: 'counters',
  routePlans: 'routePlans',
  shifts: 'shifts',
  fuelLogs: 'fuelLogs',
  maintenance: 'maintenance',
  driverPayments: 'driverPayments',
  driverCash: 'driverCash',
  cashRemittances: 'cashRemittances',
  reports: 'reports',
} as const;

// ---- Phase 6: fleet, expenses, driver pay, analytics --------------------------------------

export const EXPENSE_CATEGORIES = ['fuel', 'maintenance', 'driver_payment', 'hub', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];
export const EXPENSE_STATUSES = ['submitted', 'approved', 'rejected'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];
export const MAINTENANCE_TYPES = ['service', 'repair', 'tyres', 'inspection', 'other'] as const;
export type MaintenanceType = (typeof MAINTENANCE_TYPES)[number];
export const DRIVER_PAY_STATUSES = ['draft', 'approved', 'paid'] as const;
export type DriverPayStatus = (typeof DRIVER_PAY_STATUSES)[number];
export const PAYOUT_METHODS = ['mobile_money', 'bank_transfer', 'cash'] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];
/** Reminders: a service/document is "due soon" this close to its limit. */
export const MAINTENANCE_WARNING = { days: 14, km: 500 } as const;

/** Stable error codes returned by functions (in `details.code`) so clients can show precise messages. */
export const ERROR_CODES = [
  'VALIDATION_FAILED',
  'RATE_LIMITED',
  'PICKUP_NOT_SERVICED',
  'DESTINATION_NOT_SERVICED',
  'NO_SUITABLE_VEHICLE',
  'SAME_DAY_NOT_AVAILABLE',
  'DISTANCE_UNAVAILABLE',
  'DISTANCE_LIMIT_EXCEEDED',
  'PRICING_NOT_CONFIGURED',
  'QUOTE_NOT_FOUND',
  'QUOTE_EXPIRED',
  'QUOTE_ALREADY_USED',
  'QUOTE_MISMATCH',
  'PAYMENT_METHOD_NOT_ALLOWED',
  'PERMISSION_DENIED',
  'MFA_REQUIRED',
  'BOOKING_NOT_FOUND',
  'ALREADY_PAID',
  'PAYMENT_NOT_REQUIRED',
  'PAYMENT_PROVIDER_ERROR',
  'PAYMENT_NOT_FOUND',
  'REFUND_NOT_ALLOWED',
  'BOOKING_ALREADY_CLAIMED',
  'DELIVERY_NOT_FOUND',
  'INVALID_TRANSITION',
  'NOT_ASSIGNED_TO_YOU',
  'SHIFT_REQUIRED',
  'SHIFT_ACTIVE',
  'VEHICLE_UNAVAILABLE',
  'VEHICLE_TOO_SMALL',
  'DRIVER_UNAVAILABLE',
  'WRONG_PACKAGE',
  'CASH_NOT_CONFIRMED',
  'OTP_INVALID',
  'OTP_LOCKED',
  'EVIDENCE_REQUIRED',
  'PHASE_NOT_AVAILABLE',
  'UPLOAD_NOT_FOUND',
  'WRONG_HUB',
  'HUB_NOT_CONFIGURED',
  'MANIFEST_NOT_OPEN',
  'MANIFEST_CAPACITY',
  'ALREADY_ON_MANIFEST',
  'ROUTE_MISMATCH',
  'NOT_FOUND',
  'BUSINESS_NOT_VERIFIED',
  'CREDIT_LIMIT_EXCEEDED',
  'INVOICES_OVERDUE',
  'ALREADY_REGISTERED',
  'ACCOUNT_EXISTS',
  'BATCH_EXPIRED',
  'ODOMETER_INVALID',
  'VEHICLE_DOCUMENTS_EXPIRED',
  'ALREADY_FINAL',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
