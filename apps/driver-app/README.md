# Driver app

Expo (React Native, TypeScript), Android-first. Requires a development build (native modules:
React Native Firebase App Check, background location) — it does not run in Expo Go.

| Area | Files |
|---|---|
| Offline action queue (durable, ordered, replay-safe, photo uploads) | `src/core/queue.ts` |
| GPS send policy wrapper, offline newest-point retry | `src/core/locationReporter.ts`, `src/services/location.ts` |
| Screens: sign-in, shift/vehicle, jobs + history, job workflow | `src/screens/*` |
| Signature pad (vector strokes), label scanner (QR + manual fallback) | `src/components/*` |

```bash
pnpm --filter @courier/driver-app test       # core logic (vitest)
pnpm --filter @courier/driver-app typecheck
npx expo export --platform android           # verify the JS bundle builds
pnpm --filter @courier/driver-app build:android   # EAS build (needs google-services.json and .env)
```

Status: code complete, unit-tested core, typechecked, Android bundle builds. **Not yet run on a
device** — see the field-test checklist in `docs/11-deployment.md` §11.5.
