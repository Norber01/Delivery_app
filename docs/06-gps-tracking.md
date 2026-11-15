# 6. GPS Tracking Architecture

## 6.1 Goals
- Accurate enough for customers and dispatch; never misleading.
- Collected only while authorised (active shift or active delivery assignment).
- Affordable: bounded writes per driver per hour, no history in RTDB.

## 6.2 Data flow

```mermaid
flowchart LR
  D[Driver app<br/>foreground service] -- "every 30–60 s<br/>or ≥ 100 m moved" --> RT[(RTDB<br/>/driverLocations/{uid})]
  RT -- listener --> OPS[Dispatch map]
  CF[Cloud Function<br/>getTrackingView] -- reads if authorised --> RT
  W[Customer tracking page] -- poll 30 s / on focus --> CF
  CF -- checkpoint on status change --> FS[(Firestore trackingEvents)]
```

## 6.3 Driver app behaviour (Phase 3)
- `startShift` (callable) → server sets `/shifts/{uid}/activeUntil` (max 12 h). The driver app starts an Android foreground service with a persistent notification ("Location shared with dispatch while on shift").
- Update policy (all configurable from `config/tracking`):
  - time interval: `intervalSeconds` (default 45, allowed 30–60)
  - distance filter: send early when moved ≥ `minDistanceMeters` (default 100)
  - stationary: when speed < 2 km/h for 5 minutes, back off to `stationaryIntervalSeconds` (default 180)
  - discard fixes with accuracy worse than 100 m unless no better fix for 3 intervals
- **Weak connectivity:** the latest fix is kept locally; when offline, only the newest point is queued (older points are dropped — RTDB holds current position only). Status events (pickup, POD) are queued durably and replayed in order with their original `recordedAt`.
- `endShift` or expiry → service stops, server deletes `/driverLocations/{uid}`. RTDB rules reject writes once `activeUntil` has passed even if the app misbehaves.

## 6.4 Staleness
Each point carries `recordedAt` (device) and `serverAt` (`ServerValue.TIMESTAMP`). Clients display:
- **Live** if `now − serverAt` ≤ 2 × interval
- **Delayed** (amber, "last updated N min ago") up to 10 minutes
- **Stale** (grey marker, warning) beyond 10 minutes; ETA hidden

## 6.5 ETA
ETA is shown only when the location is Live and the Directions-based estimate exists for the current leg. Recomputed at most every 5 minutes per active delivery and only while a customer is viewing (cost control). Otherwise the page shows the delivery window.

## 6.6 Privacy
- Customers see a driver location only for their own delivery and only during the authorised last-mile/direct leg (§5.4).
- Drivers are informed by the app and employment policy; location is not collected off-shift.
- Positions older than the shift are not retained in RTDB; Firestore keeps only status checkpoints (12-month coordinate retention).

## 6.7 Map provider abstraction
`MapProvider` interface (`geocode`, `route`) lives in `packages/shared-utils/src/geo`. The Mapbox implementation is used by Functions and the edge Worker. Map display goes through `MapView` in `packages/map-ui` (Mapbox GL JS, lazy-loaded, with a tile-free schematic fallback), so the rendering library can be replaced. ETAs are cached on the delivery for 5 minutes; a per-leg route cache (`deliveryRoutes`) is planned with route optimisation (Phase 6).

## 6.8 Implementation status (Phase 3)

| Item | Where | Status |
|---|---|---|
| Send policy (interval, 100 m early send, stationary back-off, accuracy filter) | `packages/shared-utils/src/tracking` | Implemented, unit-tested |
| Shift authorisation (`/shifts/{uid}`), writes rejected without an active shift | `startShift`/`endShift`, `firebase/database.rules.json` | Implemented; rules tested; verified in the browser E2E (401 before shift, 200 during) |
| Android foreground-service location task, REST writes with App Check | `apps/driver-app/src/services/location.ts` | Implemented and bundled; **not yet run on a device** |
| Offline: newest point only, retried on next fix | `apps/driver-app/src/core/locationReporter.ts` | Implemented, unit-tested |
| Freshness (live / delayed / stale) | shared `locationFreshness`; tracking page and dispatch board | Implemented, tested |
| Customer location only while the driver holds the package | `getTrackingView` | Implemented, unit + integration + E2E tested |
| ETA via Directions, cached 5 min, only when live and out for delivery | `getTrackingView` | Implemented, unit-tested with a fake provider; live Mapbox not exercised |
| Dispatch map of all drivers on shift | `apps/admin-tools` (RTDB listener, MFA staff only) | Implemented, E2E tested with the schematic map |
| Mapbox GL rendering | `packages/map-ui` | Implemented (lazy-loaded); needs a public token to verify against real tiles |
