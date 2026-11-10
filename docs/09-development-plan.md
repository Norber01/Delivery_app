# 9. Phase-by-Phase Development Plan

Each phase ends with a **gate**: all automated tests green, rules tests green, manual UAT checklist signed off in staging, docs updated. No phase starts before the previous gate passes.

## Phase 1 — Infrastructure, website, booking, pricing  ✅ implemented in this repository (see status below)
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

## Phase 2 — Payments, customer accounts, tracking
- `PaymentProvider` with Paystack (primary) and Hubtel adapters; `initiatePayment`, webhook endpoints, reconciliation job, refunds (finance).
- Customer sign-up (phone OTP / email), saved addresses, booking history, receipts (PDF to R2).
- Public tracking page (tracking number + token or phone verification), timeline from `trackingEvents`.
- SMS notifications for booking confirmation and status changes.
- **Gate:** webhook signature tests, idempotency tests, amount-mismatch tests, sandbox end-to-end payment, rules tests for customer reads.

## Phase 3 — Driver app, dispatch, intra-city maps
- Driver app: login (device-bound), shift start/end, assignments, navigation hand-off, QR scanning, pickup confirmation, GPS foreground service, status updates, failed delivery reporting, POD (OTP/signature/photo), history, offline queue.
- Dispatch board: intake queue, assignment, live map (Mapbox GL JS) of authorised drivers, exceptions, delayed deliveries.
- `getTrackingView` with live-location authorization rules.
- **Gate:** state-machine enforcement tests, assignment authorisation tests, RTDB rules tests, GPS field test on low-end Android devices and weak network, POD OTP tests.

## Phase 4 — Hubs, vehicles, manifests, intercity
- Hub scanning (in/out), manifests (create, seal, depart, arrive), intercity route schedules, vehicle capacity checks, multi-leg tracking view.
- **Gate:** custody chain tests (no parcel in two custodies), manifest capacity tests, tracking view never shows driver location when at hub/linehaul.

## Phase 5 — Business accounts, bulk bookings, invoices
- Business registration & verification workflow, staff accounts, address book, CSV bulk upload (validated row by row, partial-failure report), contract pricing, credit limits, monthly invoices and reports.
- **Gate:** CSV validation tests, credit limit tests, invoice totals reconcile with bookings.

## Phase 6 — Route optimisation, analytics, advanced fleet
- Multi-stop route optimisation (Mapbox Optimization API or OR-Tools service), maintenance schedules, fuel analytics, driver payments, revenue/contribution analysis per route/vehicle/area, BigQuery export.
- **Gate:** optimisation compared against manual baselines, financial reports reconcile with ledger.
