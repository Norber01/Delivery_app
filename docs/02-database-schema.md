# 2. Database Schema

Firestore is the system of record. The Realtime Database stores only live location streams. Types for every document below are defined in `packages/shared-types`; write-time validation lives in `packages/validation`.

Conventions:
- IDs are Firestore auto-IDs unless stated.
- Every document has `createdAt` and `updatedAt` (server timestamps). Server-written documents also store `createdBy` (uid or `"system"`).
- Money fields are **integer pesewas** and end in `Pesewas` or live inside a `Money` object `{ amountPesewas, currency: "GHS" }`.
- Coordinates are `{ lat, lng }` numbers (WGS84). `GeoPoint` is avoided so the same type works in RTDB, Workers and clients.
- **W** column: who may write. `S` = server only (Cloud Functions / Admin SDK). `O` = owner, restricted fields. `St` = staff via rules with role checks.

## 2.1 Identity

### `users/{uid}`  — W: S
| Field | Type | Notes |
|---|---|---|
| uid | string | = Auth uid |
| role | `Role` | Mirror of custom claim. Display only; rules trust the claim, not this field |
| displayName, email, phone | string | phone in E.164 (`+233…`) |
| status | `active \| suspended \| pending_verification` | |
| businessId | string? | for `business_owner`/`business_staff` |
| mfaEnrolled | boolean | required true for staff roles before privileged access |
| fcmTokens | string[] | written via `registerDevice` function |

### `customers/{uid}` — W: O (profile fields only)
`savedAddresses: Address[]` (max 20), `defaultPaymentPreference`, `marketingOptIn`, `notificationPrefs`.

### `sellers/{businessId}` (business accounts) — W: S
`legalName`, `tradingName`, `registrationNumber` (Registrar-General), `tin` (GRA), `verificationStatus: unverified | pending | verified | rejected`, `verificationDocs: R2Key[]`, `ownerUid`, `staffUids: string[]`, `contractPricingId?`, `creditTerms?: { limitPesewas, termDays, approvedBy, approvedAt }`, `billingAddress`.

### `drivers/{uid}` — W: S
`employeeNumber`, `licenseNumber`, `licenseClass`, `licenseExpiry`, `homeHubId`, `status: available | on_shift | off_duty | suspended`, `currentVehicleId?`, `currentShiftId?`.

### `staff/{uid}` — W: S
`employeeNumber`, `role`, `hubIds: string[]` (scope for `hub_operator`), `serviceAreaIds: string[]` (scope for dispatchers), `mfaEnrolled`.

## 2.2 Network & fleet

### `serviceAreas/{id}` — W: S (admin)
`name` (e.g. "Greater Accra"), `city`, `region` (`GhanaRegion`), `center: LatLng`, `radiusKm`, `active`, `launchDate`. Intra-city pricing applies when pickup **and** destination fall inside the same active service area.

### `hubs/{id}` — W: S (admin)
`name`, `code` (e.g. `ACC-01`), `serviceAreaId`, `address`, `location`, `type: hub | warehouse | drop_point`, `operatingHours`, `active`.

### `routes/{id}` (intercity lanes) — W: S (admin)
`code` (`ACC-KSI`), `originHubId`, `destinationHubId`, `distanceKm`, `typicalDurationMinutes`, `schedule: { daysOfWeek, departureTimes[] }`, `active`.

### `vehicles/{id}` — W: S
`registrationNumber`, `vehicleClass: motorbike | car | van | truck`, `capacityKg`, `capacityM3`, `homeHubId`, `status: available | in_use | maintenance | retired`, `odometerKm`, `insuranceExpiry`, `roadworthyExpiry`.

### `vehicles/{id}/maintenance/{id}`, `vehicles/{id}/fuelLogs/{id}` — W: S
Phase 6; fuel logs also produce an `expenses` document.

## 2.3 Pricing

### `pricingRules/{version}` — W: S (admin, via `publishPricingRules`)
Immutable once published. Shape = `PricingRuleSet` (see `04-booking-and-pricing.md`). Fields: `version` (int), `status: draft | active | superseded`, `effectiveFrom`, `publishedBy`, `rules`.

### `config/pricing` — W: S
`{ activeVersion: number }` — the single pointer read by the quote engine.

### `contractPricing/{id}` — W: S (admin/finance)
`businessId`, `discountPercent?`, `routeOverrides?`, `validFrom`, `validTo`, `approvedBy`.

## 2.4 Booking & delivery

### `quotes/{id}` — W: S
Short-lived (TTL 30 min). `input` (validated `QuoteRequest`), `result` (`PriceQuote`), `pricingVersion`, `expiresAt`, `requesterUid?`, `clientIpHash`. A booking must reference a non-expired quote; the server recomputes and must get the identical total.

### `deliveryRequests/{id}` (bookings) — W: S
| Field | Notes |
|---|---|
| trackingNumber | `GH` + 10 chars Crockford base32 + check char, unique, indexed |
| customerUid? / businessId? | null for guest bookings |
| sender, recipient | `Contact { name, phone, email? }` |
| pickup, destination | `Address { line1, line2?, city, region, landmark?, ghanaPostGps?, location }` |
| packages | `PackageInfo[] { description, weightKg, lengthCm, widthCm, heightCm, quantity, declaredValuePesewas? }` |
| deliveryType | `intra_city \| intercity \| long_distance` |
| urgency | `standard \| express \| same_day` |
| specialHandling | `('fragile' \| 'perishable' \| 'high_value' \| 'documents' \| 'liquid')[]` |
| instructions | free text, max 500 |
| paymentPreference | `mobile_money \| card \| cash_on_pickup \| business_invoice` |
| price | **immutable** `PriceQuote` snapshot (lines, subtotal, discounts, total, pricingVersion, vehicleClass, distanceKm, distanceSource) |
| quoteId | |
| status | `BookingStatus`: `pending_payment \| confirmed \| cancelled` |
| paymentStatus | `unpaid \| pending \| paid \| refunded \| partially_refunded \| invoiced` (server only) |
| guestAccessHash | SHA-256 of the guest access token (guests view their booking with tracking number + token) |
| deliveryId? | set when operations converts the request into a delivery |

### `deliveries/{id}` — W: S
`requestId`, `trackingNumber`, `status: DeliveryStatus` (state machine in `05-delivery-lifecycle.md`), `currentLegId`, `legIds[]`, `currentCustodian: { type: 'driver' | 'hub' | 'vehicle', id }`, `expectedDeliveryAt?`, `exceptions[]`, `serviceAreaId`.

### `deliveries/{id}/shipmentLegs/{legId}` — W: S
`sequence`, `type: first_mile | linehaul | last_mile | direct`, `from: { type: 'address' | 'hub', hubId?, address? }`, `to`, `status: planned | assigned | in_progress | completed | failed | cancelled`, `assignmentId?`, `manifestId?`, `vehicleId?`, `driverUid?`, `startedAt?`, `completedAt?`.

### `assignments/{id}` — W: S
`deliveryId`, `legId`, `driverUid`, `vehicleId`, `assignedBy`, `status: offered | accepted | started | completed | cancelled`, `trackingAuthorizedUntil` (drives GPS authorization).

### `manifests/{id}` — W: S (Phase 4)
`routeId`, `vehicleId`, `driverUids[]`, `departureAt`, `status: open | sealed | departed | arrived | closed`, `deliveryIds[]`, `sealedBy`, `scanCounts`.

### `trackingEvents/{id}` — W: S, append-only
`deliveryId`, `trackingNumber`, `type` (status change, scan, hub_in, hub_out, exception, location_checkpoint), `status`, `location?`, `hubId?`, `actorUid`, `actorRole`, `publicMessage` (safe to show customers), `internalNote?`, `occurredAt`.

### `deliveryRoutes/{deliveryId_legId}` — W: S
Cached Directions result per leg: `polyline` (encoded), `distanceKm`, `durationMinutes`, `provider`, `computedAt`. Prevents repeat Directions calls.

### `proofOfDelivery/{deliveryId}` — W: S
`method: otp | signature | photo | otp_and_photo`, `otpVerified`, `signatureR2Key?`, `photoR2Keys[]`, `receivedByName`, `location`, `capturedAt`, `driverUid`. OTP secrets live in a separate server-only `podSecrets/{deliveryId}` doc storing only a hash and attempt counter.

## 2.5 Money

### `payments/{id}` — W: S only
`requestId`, `provider: paystack | hubtel | cash | invoice`, `providerReference`, `amountPesewas`, `currency`, `channel: mobile_money | card | bank | cash`, `status: initiated | pending | succeeded | failed | refunded`, `verifiedAt?`, `verificationSource: webhook | status_api | manual_reconciliation`, `rawEventIds[]`. Unique index on `(provider, providerReference)` enforced by deterministic doc ID `${provider}_${reference}`.

### `paymentEvents/{provider_eventId}` — W: S
Raw verified webhook payloads (idempotency key = doc ID).

### `refunds/{id}`, `invoices/{id}`, `expenses/{id}`, `driverPayments/{id}` — W: S
Invoices: `businessId`, `period`, `lines[]` (deliveryIds), `totalPesewas`, `status: draft | issued | paid | overdue | void`, `pdfR2Key`. Expenses: `category: fuel | maintenance | driver_payment | hub | other`, `amountPesewas`, `vehicleId?`, `hubId?`, `receiptR2Key?`, `approvedBy`.

## 2.6 Support & audit

- `notifications/{id}` — W: S. `recipientUid`, `channel: push | sms | email`, `template`, `deliveryId?`, `status`, `sentAt`.
- `supportTickets/{id}` — W: create by owner (validated), updates by staff/server. `customerUid?`, `trackingNumber?`, `category`, `messages` subcollection.
- `auditLogs/{id}` — W: S, append-only, never readable by non-admins. `actorUid`, `actorRole`, `action`, `targetType`, `targetId`, `before?`, `after?`, `ipHash?`, `at`.
- `rateLimits/{key}` — W: S. Fixed-window counters (`count`, `windowStart`), TTL.

## 2.7 Realtime Database layout

```
/driverLocations/{driverUid}
    lat, lng, accuracyM, speedKph, heading, recordedAt (client ms), serverAt (server ms),
    shiftId, vehicleId
/activeTracking/{deliveryId}
    driverUid, legId, authorizedUntil   (written by server only)
```

- A driver can write only `/driverLocations/{auth.uid}` and only while `auth.token.role == 'driver'` and they have an active shift flag (`/shifts/{uid}/activeUntil > now`, server-written).
- Dispatch/ops roles can read all of `/driverLocations`.
- Customers never read RTDB directly. The customer tracking page calls `getTrackingView`, which returns the driver location **only** if `/activeTracking/{deliveryId}` exists, the authorization has not expired, and the current leg's custodian is that driver.
- Firestore keeps *checkpoints* (one `trackingEvents` location record per status change, not every GPS ping) for history.

## 2.8 Relationships

```
users 1─1 customers | drivers | staff
sellers 1─* users (business staff)
deliveryRequests 1─0..1 deliveries 1─* shipmentLegs 1─0..1 assignments *─1 drivers
shipmentLegs *─0..1 manifests *─1 routes (hub → hub)
deliveries 1─* trackingEvents ; deliveries 1─0..1 proofOfDelivery
deliveryRequests 1─* payments 1─* refunds
deliveryRequests *─1 pricingRules (by version)
invoices *─* deliveryRequests (business, by period)
vehicles 1─* maintenance, fuelLogs ; expenses *─0..1 vehicles/hubs
```

## 2.9 Indexes (`firebase/firestore.indexes.json`)

| Collection | Fields | Purpose |
|---|---|---|
| deliveryRequests | trackingNumber ASC | lookup (single-field, automatic) |
| deliveryRequests | customerUid ASC, createdAt DESC | customer history |
| deliveryRequests | businessId ASC, createdAt DESC | business history |
| deliveryRequests | status ASC, createdAt DESC | dispatch intake queue |
| deliveries | serviceAreaId ASC, status ASC, updatedAt DESC | dispatch board |
| deliveries | status ASC, expectedDeliveryAt ASC | delayed delivery detection |
| assignments | driverUid ASC, status ASC, createdAt DESC | driver's job list |
| trackingEvents | deliveryId ASC, occurredAt ASC | timeline |
| payments | requestId ASC, createdAt DESC | payment history |
| manifests | routeId ASC, departureAt DESC | departures |
| expenses | category ASC, createdAt DESC | finance reports |
| auditLogs | targetType ASC, targetId ASC, at DESC | audit trail |
| supportTickets | status ASC, createdAt DESC | support queue |

## 2.10 Retention

| Data | Retention | Mechanism |
|---|---|---|
| RTDB `/driverLocations` | Overwritten each update; node deleted at shift end | `endShift` function + hourly sweep |
| Location checkpoints in `trackingEvents` | 12 months, then coordinates nulled | Scheduled function |
| `quotes` | 30 minutes | Firestore TTL on `expiresAt` |
| `rateLimits` | 24 hours | Firestore TTL on `expiresAt` |
| Bookings, deliveries, payments, invoices | 7 years (tax/accounting) | Archive to cold storage export after 2 years |
| POD photos & signatures (R2) | 24 months | R2 lifecycle rule |
| `auditLogs` | 7 years | Never deleted by app code |
| Guest personal data | Contacts pseudonymised 24 months after delivery | Scheduled function |

Retention periods must be confirmed with the company's legal advisor under the Data Protection Act, 2012 (Act 843) and GRA record-keeping requirements.

## 2.11 Validation requirements

All writes pass through `zod` schemas in `packages/validation` inside Cloud Functions. Key rules:
- Ghana phone numbers normalised to E.164 `+233XXXXXXXXX`, valid mobile prefixes only.
- GhanaPost GPS digital addresses match `^[A-Z]{2}-\d{3,4}-\d{4}$`.
- Coordinates must fall within Ghana's bounding box (lat 4.5–11.3, lng −3.4–1.3).
- Weight 0.01–1000 kg per package; each dimension 1–300 cm; quantity 1–500.
- Text fields trimmed, length-limited, control characters rejected.
- Firestore rules provide a second, independent layer (see `firebase/firestore.rules`): clients cannot write server-owned collections at all.
