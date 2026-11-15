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

## Phase 4 — Hubs, vehicles, manifests, intercity
- Hub scanning (in/out), manifests (create, seal, depart, arrive), intercity route schedules, vehicle capacity checks, multi-leg tracking view.
- **Gate:** custody chain tests (no parcel in two custodies), manifest capacity tests, tracking view never shows driver location when at hub/linehaul.

## Phase 5 — Business accounts, bulk bookings, invoices
- Business registration & verification workflow, staff accounts, address book, CSV bulk upload (validated row by row, partial-failure report), contract pricing, credit limits, monthly invoices and reports.
- **Gate:** CSV validation tests, credit limit tests, invoice totals reconcile with bookings.

## Phase 6 — Route optimisation, analytics, advanced fleet
- Multi-stop route optimisation (Mapbox Optimization API or OR-Tools service), maintenance schedules, fuel analytics, driver payments, revenue/contribution analysis per route/vehicle/area, BigQuery export.
- **Gate:** optimisation compared against manual baselines, financial reports reconcile with ledger.
