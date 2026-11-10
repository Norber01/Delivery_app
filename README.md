# Ghana Nationwide Courier & Logistics Platform

Monorepo for a company-operated courier service in Ghana: own vehicles, own drivers, own hubs, one central dispatch team. Customers (individuals, online sellers, businesses) book directly.

## Status

| Phase | Scope | Status |
|---|---|---|
| 0 | Architecture & design documents | ✅ Complete — see [`docs/`](docs/README.md) |
| 1 | Infrastructure, website, booking, pricing | ✅ Implemented & tested (needs real Firebase/Cloudflare/Mapbox projects to go live) |
| 2 | Payments, customer accounts, tracking | ✅ Implemented & tested (needs Paystack/SMS accounts to go live) |
| 3 | Driver app, dispatch, intra-city maps | Not started |
| 4 | Hubs, vehicles, manifests, intercity | Not started |
| 5 | Business accounts, bulk bookings, invoices | Not started |
| 6 | Route optimisation, analytics, fleet | Not started |

**What works in Phase 1:** guests can search addresses (via the edge Worker), describe packages, get a server-calculated itemised price (intra-city, intercity or long-distance, with weight, urgency, handling, bulk and contract rules), and confirm a booking that stores an immutable price snapshot under a unique tracking number.

**What works in Phase 2:** online payment by Mobile Money or card through Paystack's hosted checkout, credited only after signature-checked webhooks are re-verified with Paystack (with polling and scheduled reconciliation as fallbacks); finance refunds; public and private tracking pages; customer accounts (phone or email) with booking history, saved addresses, claiming guest bookings and SMS preferences; printable receipts; SMS notifications.

**Not yet available:** driver app, dispatch and ops/finance dashboards, live maps, hubs and intercity manifests, business accounts (Phases 3–6).

## Layout

```
apps/web            Public site + booking (React, TypeScript, Tailwind, Vite) → Cloudflare Pages
apps/admin-tools    Dispatch/admin/finance/fleet dashboards (Phase 2+)
apps/driver-app     React Native driver app, Android-first (Phase 3)
functions           Firebase Cloud Functions (quotes, bookings, payments, refunds, tracking, accounts, SMS, pricing, roles)
workers/api-edge    Cloudflare Worker: cached, rate-limited geocoding proxy
packages/*          constants, shared-types, validation (zod), shared-utils (pricing engine, lifecycle, geo)
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
