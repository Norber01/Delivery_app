# 8. Project Folder Structure

pnpm workspace monorepo.

```
.
├── apps/
│   ├── web/                 Public booking site + customer (Ph2) + business (Ph5) dashboards
│   │                        Vite, React, TypeScript, Tailwind → Cloudflare Pages
│   ├── admin-tools/         Ops app: dispatch + fleet (Ph3), hubs (Ph4), finance (later) — separate host behind Cloudflare Access
│   └── driver-app/          Expo / React Native (TypeScript), Android-first (Ph3)
├── functions/               Firebase Cloud Functions v2 (TypeScript, bundled with esbuild)
│   ├── src/
│   │   ├── services/        quotes, bookings, payments, refunds, tracking, accounts, notifications
│   │   ├── ops/             deliveries: pure decisions, dispatch/driver/shift/fleet services, Firestore+RTDB store
│   │   ├── payments/        PaymentProvider port + Paystack adapter
│   │   ├── notifications/   SMS port + Hubtel adapter, templates
│   │   ├── store/           persistence ports and Firestore implementations
│   │   ├── lib/             auth guards, errors, hashing
│   │   └── index.ts         exports deployed functions (callables, webhook, triggers, schedules)
│   ├── test/                unit tests (vitest, in-memory stores) — no emulator needed
│   ├── test-integration/    emulator integration tests + browser E2E harness
│   └── scripts/             build/deploy packaging, seed, bootstrap-admin
├── workers/
│   └── api-edge/            Cloudflare Worker: geocoding proxy (cache, rate limits) + signed R2 evidence storage
├── packages/
│   ├── constants/           roles, statuses, delivery types, regions, collection names
│   ├── shared-types/        TypeScript domain types (Firestore documents, API contracts)
│   ├── validation/          zod schemas shared by clients and functions
│   ├── shared-utils/        pricing engine, lifecycle state machine, geo, GPS send policy, upload tokens, money, tracking numbers
│   └── map-ui/              MapView (Mapbox GL, lazy) with tile-free schematic fallback — web + ops app
├── firebase/
│   ├── firestore.rules
│   ├── firestore.indexes.json
│   ├── database.rules.json  (RTDB)
│   ├── storage.rules        (Firebase Storage unused → deny all)
│   ├── seed/                sample config (service areas, pricing rules)
│   └── rules-tests/         security rules tests (emulator)
├── docs/                    this documentation
├── firebase.json, .firebaserc.example
└── pnpm-workspace.yaml, tsconfig.base.json, package.json
```

**Adjustments to the suggested structure (justified):**
- `workers/` contains one directory per Worker, so further Workers (e.g. R2 signed-upload gateway) can be added independently.
- Interfaces 1–3 share `apps/web`; 5–6 share `apps/admin-tools` — see `01-system-architecture.md` §1.2.
- `firebase/rules-tests` lives next to the rules it tests.
- Shared packages are consumed as TypeScript source (no publish step); Functions bundle them with esbuild, Vite bundles them for the web, Metro for the driver app.
