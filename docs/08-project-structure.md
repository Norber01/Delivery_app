# 8. Project Folder Structure

pnpm workspace monorepo.

```
.
├── apps/
│   ├── web/                 Public booking site + customer (Ph2) + business (Ph5) dashboards
│   │                        Vite, React, TypeScript, Tailwind → Cloudflare Pages
│   ├── admin-tools/         Dispatch (Ph3–4) + admin/finance/fleet (Ph2–6) — separate host behind Cloudflare Access
│   └── driver-app/          React Native (TypeScript), Android-first (Ph3)
├── functions/               Firebase Cloud Functions v2 (TypeScript, bundled with esbuild)
│   ├── src/
│   │   ├── callable/        getQuote, createBooking, (later) payments, assignments …
│   │   ├── services/        quoteService, bookingService — pure logic with injected repositories
│   │   ├── lib/             auth guards, errors, rate limiter, audit log, hashing, map provider
│   │   └── index.ts         exports deployed functions
│   ├── test/                unit tests (vitest) — no emulator needed
│   └── scripts/             build/deploy packaging
├── workers/
│   └── api-edge/            Cloudflare Worker: geocoding proxy with caching + rate limiting
├── packages/
│   ├── constants/           roles, statuses, delivery types, regions, collection names
│   ├── shared-types/        TypeScript domain types (Firestore documents, API contracts)
│   ├── validation/          zod schemas shared by clients and functions
│   └── shared-utils/        pricing engine, lifecycle state machine, geo, money, tracking numbers, phone
├── firebase/
│   ├── firestore.rules
│   ├── firestore.indexes.json
│   ├── database.rules.json  (RTDB)
│   ├── storage.rules        (Firebase Storage unused → deny all)
│   ├── seed/                sample config (service areas, pricing rules)
│   └── rules-tests/         security rules tests (emulator)
├── scripts/                 seeding / pricing publication / bootstrap admin
├── docs/                    this documentation
├── firebase.json, .firebaserc.example
└── pnpm-workspace.yaml, tsconfig.base.json, package.json
```

**Adjustments to the suggested structure (justified):**
- `workers/` contains one directory per Worker, so further Workers (e.g. R2 signed-upload gateway) can be added independently.
- Interfaces 1–3 share `apps/web`; 5–6 share `apps/admin-tools` — see `01-system-architecture.md` §1.2.
- `firebase/rules-tests` lives next to the rules it tests.
- Shared packages are consumed as TypeScript source (no publish step); Functions bundle them with esbuild, Vite bundles them for the web, Metro for the driver app.
