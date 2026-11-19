# Ghana Nationwide Courier & Logistics Platform

Monorepo for a company-operated courier service in Ghana: own vehicles, own drivers, own hubs, one central dispatch team. Customers (individuals, online sellers, businesses) book directly.

## Setting up

**From a phone, no computer needed:** follow [docs/13-phone-setup.md](docs/13-phone-setup.md). GitHub Actions does the building and deploying (**Deploy**, **Admin tasks**, **Driver app (Android)** workflows); you fill in a few settings.

## Status

| Phase | Scope | Status |
|---|---|---|
| 0 | Architecture & design documents | ✅ Complete — see [`docs/`](docs/README.md) |
| 1 | Infrastructure, website, booking, pricing | ✅ Implemented & tested (needs real Firebase/Cloudflare/Mapbox projects to go live) |
| 2 | Payments, customer accounts, tracking | ✅ Implemented & tested (needs Paystack/SMS accounts to go live) |
| 3 | Driver app, dispatch, intra-city maps | ✅ Implemented & tested in emulators/browsers; driver app needs device field-testing |
| 4 | Hubs, vehicles, manifests, intercity | ✅ Implemented & tested in emulators/browsers (driver-app hub steps need device testing) |
| 5 | Business accounts, bulk bookings, invoices | ✅ Implemented & tested in emulators/browsers (invoice emails and online invoice payment not yet) |
| 6 | Route optimisation, analytics, fleet | ✅ Implemented & tested in emulators/browsers (driver-app screens need device testing) |

**What works in Phase 1:** guests can search addresses (via the edge Worker), describe packages, get a server-calculated itemised price (intra-city, intercity or long-distance, with weight, urgency, handling, bulk and contract rules), and confirm a booking that stores an immutable price snapshot under a unique tracking number.

**What works in Phase 2:** online payment by Mobile Money or card through Paystack's hosted checkout, credited only after signature-checked webhooks are re-verified with Paystack (with polling and scheduled reconciliation as fallbacks); finance refunds; public and private tracking pages; customer accounts (phone or email) with booking history, saved addresses, claiming guest bookings and SMS preferences; printable receipts; SMS notifications.

**What works in Phase 3:** confirmed bookings become deliveries; dispatchers (with two-step sign-in) see a live board and map, assign drivers on shift, and handle exceptions; drivers start shifts on a vehicle, share GPS only while on shift, scan labels, collect cash, and complete deliveries with the recipient's SMS code (or signature + photo); customers see the driver's live position only while their package is out for delivery.

**What works in Phase 4:** intercity parcels move pickup driver → origin hub → linehaul manifest → destination hub → last-mile driver, with a scan at every hand-over by hub staff limited to their own hubs; manifests check route, vehicle capacity and that each parcel is on only one; anything not unloaded is flagged missing; customers see "At our Accra hub" / "In transit to Kumasi" with an expected arrival, never a vehicle position.

**What works in Phase 5:** companies register with their Registrar-General and TIN details and documents, are verified by an administrator, add staff, keep an address book, upload up to 200 deliveries at once from a CSV (checked and priced row by row before anything is booked, with printable labels), and — once finance approves credit — book on a monthly invoice. Finance generates invoices, records payments and sees overdue accounts; businesses see their invoices and monthly delivery reports.

**What works in Phase 6:** dispatch (or the driver) plans each driver's stops in the best order; drivers record odometer readings and fuel with receipt photos; fleet managers keep service schedules, insurance and roadworthy dates (expired papers block the vehicle) and maintenance records; finance approves expenses, runs monthly driver pay statements, tracks cash drivers collect and hand in, and gets a monthly report of revenue, costs and contribution by area, route and vehicle with automatic reconciliation checks. Optional daily export to BigQuery.

**Not yet available:** invoice emails and online invoice payment, payroll deductions, hub drop-off/collection by customers, automated intercity returns.

## Layout

```
apps/web            Public site + booking (React, TypeScript, Tailwind, Vite) → Cloudflare Pages
apps/admin-tools    Ops app: dispatch board, fleet (React, Vite) — separate host behind Cloudflare Access
apps/driver-app     Driver app (Expo / React Native, Android-first)
functions           Firebase Cloud Functions (quotes, bookings, payments, refunds, tracking, accounts, SMS, pricing, roles)
workers/api-edge    Cloudflare Worker: geocoding proxy + signed POD-photo storage in R2
packages/*          constants, shared-types, validation (zod), shared-utils (pricing, lifecycle, geo, GPS policy), map-ui
firebase            Firestore/RTDB/Storage rules, indexes, seed config, rules tests
docs                Architecture, schema, permissions, workflows, security, deployment
```

## Quick start

```bash
corepack enable && pnpm install
pnpm test          # 100+ unit tests across packages, functions, worker and web
pnpm test:rules    # security rules tests (Firebase emulators; needs Java)
```

See [docs/11-deployment.md](docs/11-deployment.md) for local stack, environment setup and deployment.

## Key principles
- Prices are computed and stored **only on the server**; every booking keeps its price breakdown and pricing version.
- Money is **integer pesewas** everywhere.
- Roles come from **Auth custom claims** set by audited functions; staff actions require **MFA**.
- Clients cannot write bookings, payments, pricing or audit logs — enforced by rules and tested.
- Map and payment providers sit behind interfaces so they can be replaced.
