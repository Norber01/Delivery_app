# 9. Phase-by-Phase Development Plan

Each phase ends with a **gate**: all automated tests green, rules tests green, manual UAT checklist signed off in staging, docs updated. No phase starts before the previous gate passes.

## Phase 1 — Infrastructure, website, booking, pricing  ✅ implemented
- Monorepo, shared packages, CI-able scripts.
- Pricing engine (all rule types in §4.2) with unit tests.
- Delivery lifecycle state machine with tests (used from Phase 3, defined now so booking statuses are consistent).
- Validation schemas (Ghana phones, GhanaPost GPS, coordinates, packages).
- Cloud Functions: `getQuote`, `createBooking`, `publishPricingRules`, `setUserRole`; rate limiting; audit logging; App Check enforced.
- Firestore rules (deny-by-default, server-owned collections), indexes, RTDB rules.
- Edge Worker geocoding proxy with cache and rate limits.
- Public website: home, services, booking wizard (addresses → packages → quote → contacts → confirmation).
- **Gate tests:** pricing, validation, tracking number, booking service (quote expiry, reuse, tamper), rules tests.

**Phase 1 status (honest summary):**
- Implemented and unit-tested: pricing engine, lifecycle state machine, validation, tracking numbers, quote and booking services, role-assignment and pricing-publication guards, edge Worker geocode handler, web draft conversion.
- Integration-tested against the Firestore emulator: `FirestoreStore` transactions (quote single-use under concurrent bookings, versioned pricing publication, rate-limit counters, null optional fields from the callable SDK).
- Security rules tests (Firestore + RTDB) run against the emulators (`pnpm test:rules`).
- Browser smoke test: the production web build was driven through the full booking flow with Playwright against the real services and Firestore emulator (harness: `functions/test-integration/e2e-shim.ts`). Screenshots in `docs/screenshots/`.
- Not yet exercised: deployed Cloud Functions with real App Check tokens, live Mapbox calls, Cloudflare Pages/Worker deployment — these need the company's Firebase, Cloudflare and Mapbox accounts.
- Not in Phase 1: online payment (Mobile Money/card bookings are recorded as `pending_payment` for manual confirmation until Phase 2), tracking page, accounts, staff UI.

## Phase 2 — Payments, customer accounts, tracking  ✅ implemented
- `PaymentProvider` with Paystack adapter; `initiatePayment`, `paystackWebhook`, `getPaymentStatus`, scheduled `reconcilePayments`, `refundPayment` (finance).
- Customer sign-up (phone OTP / email with verification), `completeSignUp` (grants `customer` only to accounts with no role), guest-booking claim, saved addresses, booking history, SMS preferences.
- Public tracking page (tracking number → public view; owner session or access code → full view) and timeline from `trackingEvents`.
- Printable receipts (browser print/PDF) from server data.
- SMS notifications (booking created/pending payment, payment received, refund processed) through a queue + Hubtel adapter, honouring customer preferences.
- **Gate tests:** webhook signature, idempotency (including concurrent duplicate deliveries), amount/currency mismatch, duplicate payments, refund caps (including concurrent requests), tracking privacy, sign-up role safety, rules for customer reads.

**Phase 2 status (honest summary):**
- Unit-tested: Paystack adapter, payment/refund decisions and services, tracking view, accounts, notifications (66 function tests).
- Emulator integration tests: concurrent webhook deliveries credit once; concurrent refunds capped; guest-booking claim moves payments too (this caught a transaction read-after-write bug, fixed).
- Browser E2E (`functions/test-integration/e2e-browser.cjs`) against the Auth + Firestore emulators with real rules and a local Paystack stand-in: book → hosted checkout → signed webhook → verified confirmation → receipt; public tracking without personal data; wrong access code; email sign-up + verification → claim booking → saved address reused in booking; declined payment → retry.
- Not yet exercised: real Paystack test-mode keys and dashboard webhooks, real SMS delivery (Hubtel sender ID approval), phone-OTP sign-in in a real browser (needs reCAPTCHA on a real domain).
- Not in Phase 2: Hubtel payments adapter, finance/support staff UI, email receipts, support tickets (come with the ops app).

## Phase 3 — Driver app, dispatch, intra-city maps  ✅ implemented (driver app not yet run on a device)
- Deliveries created from confirmed bookings; dispatcher actions (assign, unassign, reschedule, reattempt, return to sender, cancel, hold, release) with shift, area and vehicle-size checks.
- Driver actions, idempotent per `actionId`: start, scan-verified pickup with cash collection, OTP proof of delivery (5-attempt lock), signature + photo fallback, failed pickup/delivery reporting, return to sender.
- Shifts reserving a vehicle and authorising GPS; live tracking with freshness and ETA; delayed-delivery flagging.
- POD photos in private R2 via HMAC-signed Worker URLs.
- Ops app: staff MFA (SMS or authenticator) sign-in and enrolment, live dispatch board and map, POD review, fleet (drivers via set-password links, vehicles).
- Driver app (Expo/React Native, Android-first): shifts, background GPS, offline action queue with photo uploads, label scanning, delivery code / signature / photo capture, problem reports, history.
- Web: live driver map on tracking, delay notice, printable QR shipping labels.
- **Gate tests:** state-machine enforcement, assignment authorisation, RTDB rules, POD OTP, replayed actions, races (double assignment, shared vehicle), live-location custody rules.

**Phase 3 status (honest summary):**
- Unit tests: 91 functions tests (25 for operations), shared tracking policy and upload tokens, Worker evidence storage, dispatch ranking, driver-app core (offline queue, location reporter, signatures).
- Emulator integration tests (Firestore + RTDB): end-to-end delivery with RTDB shift authorisation; exactly one winner when two dispatchers assign the same delivery or two drivers take the same vehicle; concurrent replays applied once; wrong codes counted; shift end blocked while holding a package.
- Rules tests: driver read scope, no direct writes to deliveries/assignments/vehicles, POD and codes server-side/staff-only, timeline readable by ops only.
- Browser E2E (`functions/test-integration/e2e-phase3.cjs`): booking → QR label → staff without MFA forced to enrol → admin SMS-MFA sign-in → vehicle + driver creation → driver sets password from link → shift → dispatch assignment from the board (map, ranked driver) → wrong label rejected → cash pickup → public live tracking without personal data → wrong code then correct code → POD visible to ops → customer sees Delivered with no live location.
- Driver app: TypeScript-checked and its Android JavaScript bundle builds (Metro, 837 modules). **It has not been installed or run on an Android device**, so background GPS behaviour, camera scanning, App Check (Play Integrity) and battery use still need a field test on low-end devices and weak networks (the original gate).
- Not exercised against real services: Mapbox tiles/Directions, Hubtel SMS delivery of codes, R2 (Worker tested with a fake bucket).
- Deferred: intercity legs and hub custody (Phase 4 — dispatch refuses them explicitly), push notifications to drivers (FCM), dispatcher service-area scoping UI (claim supported server-side), finance UI for cash reconciliation.

## Phase 4 — Hubs, vehicles, manifests, intercity  ✅ implemented
- Hubs and intercity routes (admin, Network page or seed file); resolved onto intercity deliveries (primary hub per service area).
- First mile ends at the origin hub (no delivery code); hub operators scan parcels in; manifests are created per route departure, loaded by scan with route/capacity/one-manifest checks, sealed, and departed only when the linehaul driver is on shift with that vehicle; arrival is recorded at the destination hub before unloading scans; closing flags anything not unloaded as missing (cleared when found).
- Last mile assigned by dispatch in the destination area; the hub hands the parcel to that driver (delivery code issued then); failed last-mile deliveries come back into the hub.
- Hub operators restricted to their `hubIds`; shift end blocked while a manifest is on the road; customers see hub/in-transit wording and expected hub arrival, never a vehicle or linehaul driver position.
- **Gate tests:** custody chain (one custodian at every step, wrong-hub refusal), manifest capacity and single-manifest rules, tracking privacy during linehaul.

**Phase 4 status (honest summary):**
- Unit tests: intercity journey end to end, failed last mile back to hub, manifest capacity/route/duplicate/scope rules, missing-parcel closure and recovery (functions: 98 tests total).
- Emulator integration: multi-parcel departure/arrival transactions; two manifests loading the same parcel concurrently → exactly one succeeds; shift end blocked during linehaul.
- Rules: manifests readable by MFA ops/hub staff and their own linehaul driver only; no client writes to manifests or hubs.
- Browser E2E (`functions/test-integration/e2e-phase4.cjs`) with two hub operators each scoped to their hub, verified twice (clean data and on top of earlier runs).
- Found and fixed during E2E: SDK status codes ("[400]") leaking into messages; timeline ordering of same-millisecond events; dispatch cards re-ordering under the cursor (now sorted by due time); a reused driver-action id for a different action returned the earlier result as success (now rejected).
- Not built: customer drop-off at / collection from hubs, intercity return to sender (refused with guidance; handled manually), multi-hop routes (one linehaul per parcel), manifest printing, scheduled-departure reminders. Driver-app hub steps are code-complete but, like Phase 3, **not yet run on a device**.

## Phase 5 — Business accounts, bulk bookings, invoices  ✅ implemented
- **Registration & verification:** a signed-in customer registers a company (Registrar-General number, GRA TIN, contact, pickup/billing address, certificate upload via signed URL to R2) and becomes `business_owner` at once (prepaid bookings work immediately). Admins review the documents in the ops app and verify, reject (with reason) or suspend; rejecting or suspending withdraws credit.
- **Staff:** the owner invites up to 50 staff by work email (one-time password-setup link; existing accounts are refused rather than taken over) and can remove them (claims reset, sessions revoked).
- **Address book** of the business's customers (up to 2,000), usable from the booking form.
- **CSV bulk upload** (≤200 rows): template download, client-side parse with column check, server-side validation row by row with plain-English errors, geocoding of rows without coordinates (with the matched place shown), pricing with volume tiers and contract discount, 60-minute price hold, confirm creates only valid rows (idempotent per row, so a double click or retry books nothing twice), printable QR labels and a tracking-number CSV.
- **Credit & invoices:** finance sets a credit limit and payment terms (7–90 days) and contract discounts. Invoice billing is offered only to verified businesses with credit left and nothing overdue; the limit is checked inside each booking's transaction. Invoices are generated monthly (scheduled, or on demand by finance; safe to re-run), numbered sequentially, split above 400 lines; finance records bank/MoMo/cheque/cash payments (part or full), which release credit; unpaid invoices can be voided (their bookings return to the next run); a daily job marks overdue invoices and pauses account billing. Cancelling an un-invoiced account booking releases its credit; one already invoiced is flagged for a credit note (audit `invoice.adjustment_required`).
- **Reports:** monthly bookings, delivered, in progress, on-time %, failed attempts, spend, service mix, top destinations, CSV export; printable invoice page.
- **Gate tests:** CSV parsing/formula-injection and row validation (validation 36, shared-utils 55), business/bulk/invoice services (functions 114), emulator races — concurrent bookings cannot exceed the credit limit, a double bulk confirm books each row once, overlapping invoice runs never bill a booking twice and totals reconcile with bookings (integration 19), rules (31), and a browser E2E of the whole flow (`e2e-phase5.cjs`).
- **Not done / needs real accounts:** emails for staff invitations and invoices (the owner copies the setup link; invoices are viewed/printed in the dashboard), payment of invoices online through Paystack (finance records payments manually), credit notes as documents (flagged in the audit log only), and VAT/NHIL/GETFund line breakdown on invoices pending the company's tax registration details.

## Phase 6 — Route optimisation, analytics, advanced fleet
- Multi-stop route optimisation (Mapbox Optimization API or OR-Tools service), maintenance schedules, fuel analytics, driver payments, revenue/contribution analysis per route/vehicle/area, BigQuery export.
- **Gate:** optimisation compared against manual baselines, financial reports reconcile with ledger.
