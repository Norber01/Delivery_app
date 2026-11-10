# 12. Cost Control

| Service | Free allowance used initially | Controls |
|---|---|---|
| Firestore | Spark/Blaze free quota (reads/writes/day) | Quotes TTL; no GPS history in Firestore; checkpoints only on status change; pagination everywhere; denormalised public tracking view to avoid fan-out reads |
| RTDB | 1 GB stored / 10 GB/month download | One node per driver (overwrite); 30–60 s interval + distance filter; dispatch subscribes to service-area subtree only |
| Cloud Functions | Blaze free invocations | `minInstances: 0`; bundle size small; in-memory caching of pricing rules and service areas (5 min) |
| Mapbox | Free monthly tiers for map loads, geocoding, directions | Geocoding via Worker with Cloudflare cache (24 h) and per-IP limits; debounced autocomplete (≥ 3 chars, 350 ms); Directions only in `getQuote` (not intercity) and cached per leg; ETA only while viewed |
| Cloudflare | Pages/Workers free plan | Workers paid plan only when request volume requires |
| SMS | Pay-as-you-go | OTP only for POD and sign-in; status SMS configurable per customer |

Budget alerts: set GCP budget with alerts at 50/80/100 % (Firebase is billed through GCP), Mapbox usage alerts in account settings, Cloudflare usage notifications. Review a monthly cost report per delivery (cost/delivery KPI). Do not assume commercial usage stays within free tiers — Blaze plan is required for Cloud Functions and outbound network calls (Mapbox, Paystack).
