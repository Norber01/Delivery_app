# 11. Setup & Deployment

## 11.1 Prerequisites
- Node.js 22, pnpm 10 (`corepack enable`)
- Firebase CLI (`pnpm dlx firebase-tools@15 …` or a global install) and Java 21+ for emulators
- Cloudflare account with Wrangler (installed as a dev dependency of `workers/api-edge`)
- Mapbox account (two tokens: a **server** token for Directions/Geocoding, a **public** URL-restricted token for GL JS from Phase 3)

## 11.2 Local development

```bash
pnpm install
pnpm test                      # unit tests: shared packages, functions services, worker, web
pnpm test:rules                # Firestore + RTDB security rules against the emulators
pnpm --filter @courier/functions test:integration   # FirestoreStore + services against the Firestore emulator
# Browser E2E: Phases 1–2 functions/test-integration/e2e-browser.cjs, Phase 3 e2e-phase3.cjs (see their headers)
pnpm --filter @courier/admin-tools dev    # ops app on http://localhost:5174
pnpm --filter @courier/driver-app test    # driver-app core logic (the app itself needs an Android device/emulator)

# Run the stack
firebase emulators:start --project demo-courier --only auth,firestore,database,functions
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 pnpm --filter @courier/functions seed --project demo-courier
cp workers/api-edge/.dev.vars.example workers/api-edge/.dev.vars   # add a Mapbox token
pnpm dev:worker                # http://localhost:8787
cp apps/web/.env.example apps/web/.env.local                       # VITE_USE_EMULATORS=true
pnpm dev:web                   # http://localhost:5173
```

`firebase.json` runs `functions` from `functions/.deploy`, which `pnpm --filter @courier/functions build` produces (esbuild bundle + deploy-only `package.json`). The emulator therefore needs a build first.

## 11.3 One-time project setup (per environment: staging, production)

1. **Firebase project** on the Blaze plan (required for outbound calls to Mapbox/payment providers). Create Firestore (Native mode) and Realtime Database in `europe-west1`.
2. **Authentication**: enable Email/Password and Phone providers; upgrade to Identity Platform and enable **MFA** (TOTP + SMS).
3. **App Check**: register the web app with reCAPTCHA Enterprise and the Android app with Play Integrity. After verifying traffic in the console metrics, turn on enforcement for Firestore, RTDB and Cloud Functions.
4. **Secrets** (Google Secret Manager via Firebase):
   ```bash
   firebase functions:secrets:set MAPBOX_SERVER_TOKEN --project <id>
   firebase functions:secrets:set IP_HASH_SALT --project <id>          # 32+ random bytes
   firebase functions:secrets:set PAYSTACK_SECRET_KEY --project <id>   # sk_test_… in staging, sk_live_… in production
   firebase functions:secrets:set HUBTEL_SMS_CLIENT_ID --project <id>  # enter "unset" until SMS is contracted
   firebase functions:secrets:set HUBTEL_SMS_CLIENT_SECRET --project <id>
   ```
   Non-secret parameters are prompted on first deploy (or set in `functions/.env.<project-id>`):
   `PUBLIC_SITE_URL`, `COMPANY_NAME`, `PAYMENT_FALLBACK_EMAIL_DOMAIN`, `SMS_SENDER_ID`.
   While the SMS secrets are `unset`, notifications are recorded with status `skipped` (nothing is sent).
   **Note:** delivery codes for proof of delivery are sent by SMS, so SMS must be configured before drivers deliver.
   Phase 3 adds `firebase functions:secrets:set UPLOAD_SIGNING_SECRET` (32+ random bytes; the same value is set on the Worker) and the `EDGE_WORKER_URL` parameter.
   **Paystack:** set the dashboard webhook URL to the deployed `paystackWebhook` function URL.
   **Auth:** enable Email/Password (with email verification) and Phone providers; add the site domain to authorised domains.
5. **TTL policies** (cost control and data retention):
   ```bash
   gcloud firestore fields ttls update expiresAt --collection-group=quotes --enable-ttl --project <id>
   gcloud firestore fields ttls update expiresAt --collection-group=rateLimits --enable-ttl --project <id>
   ```
6. **Backups**: enable PITR and a daily backup schedule:
   ```bash
   gcloud firestore databases update --database='(default)' --enable-pitr --project <id>
   gcloud firestore backups schedules create --database='(default)' --recurrence=daily --retention=30d --project <id>
   ```
7. **Budget alerts** in Google Cloud Billing (50/80/100 %) and Mapbox usage alerts.
8. **Seed configuration** (review prices first — the sample values are illustrative):
   ```bash
   pnpm --filter @courier/functions seed --project <id> --pricing ./prices.json --areas ./areas.json
   ```
9. **First super admin**: the person signs up, verifies their email, then an operator runs
   `pnpm --filter @courier/functions bootstrap-admin --project <id> --email owner@company.com.gh`.
   They must enrol MFA before staff functions accept their requests.

## 11.4 Deploying

```bash
cp .firebaserc.example .firebaserc                # set project ids
firebase use staging
firebase deploy --only firestore:rules,firestore:indexes,database,storage
firebase deploy --only functions                   # predeploy builds the bundle

# Edge worker
cd workers/api-edge
wrangler secret put MAPBOX_TOKEN --env production
wrangler deploy --env production

# Website (Cloudflare Pages)
# Pages project → build command: pnpm --filter @courier/web build
#                 output directory: apps/web/dist
#                 env vars: VITE_FIREBASE_*, VITE_RECAPTCHA_ENTERPRISE_SITE_KEY, VITE_EDGE_API_URL, VITE_COMPANY_NAME, VITE_SUPPORT_PHONE
```

`apps/web/public/_headers` sets security headers (CSP, HSTS, frame denial) and `_redirects` provides SPA routing. Update the CSP `connect-src` with the production Worker hostname.

**Release order:** rules & indexes → functions → worker → web. Rules must ship before any client relying on them. Promote staging → production only after the phase gate (docs/09) passes in staging.

## 11.5 Operations app, driver app and evidence storage (Phase 3)

**Ops app (`apps/admin-tools`)** — a second Cloudflare Pages project (build `pnpm --filter @courier/admin-tools build`, output `apps/admin-tools/dist`) on its own hostname (e.g. `ops.example.com.gh`), protected by **Cloudflare Access** with the company identity provider. Env vars as in `apps/admin-tools/.env.example` (include `VITE_FIREBASE_DATABASE_URL`). Update the CSP `img-src`/`connect-src` in `public/_headers` with the real Worker hostname. Staff must enrol a second factor on first sign-in (Identity Platform MFA: enable SMS and TOTP).

**Staff and drivers** — staff roles are granted with `setUserRole` (or `bootstrap-admin` for the first super admin). Drivers and vehicles are created in the ops app's Fleet page; the driver receives a one-time set-password link (staff never handle passwords).

**Evidence storage (R2)** — create the private buckets named in `workers/api-edge/wrangler.toml` (`courier-evidence-staging`, `courier-evidence`), add a lifecycle rule deleting objects after 24 months, then `wrangler secret put UPLOAD_SIGNING_SECRET --env production`.

**Driver app (`apps/driver-app`)** — Expo dev-client app (native modules: React Native Firebase App Check, background location):
1. Register the Android app (`gh.example.courier.driver` — change in `app.json`) in Firebase; download `google-services.json` into `apps/driver-app/` (git-ignored).
2. App Check: enable Play Integrity for the app; for development builds register the debug token printed in logcat.
3. Copy `.env.example` to `.env` with the Firebase web config and `EXPO_PUBLIC_FIREBASE_DATABASE_URL`.
4. `pnpm --filter @courier/driver-app build:android` (EAS Build, internal APK) or `npx expo run:android` with a local Android SDK.
5. On first launch drivers must allow location **all the time**; the app runs a foreground service (persistent notification) only while on shift.
6. Field-test on the cheapest phones in the fleet before rollout: background GPS on weak networks, battery drain over a full shift, camera scanning of printed labels.

**Labels** — senders print the QR label from the booking confirmation or tracking page (`/label/<tracking number>`); drivers can type the tracking number if a label is missing or damaged.

**Hubs (Phase 4)** — define hubs and routes (edit `firebase/seed/network.sample.json` and run the seed, or use the ops app's Network page as an admin). Each service area with intercity traffic needs exactly one active `primaryForArea` hub, and every route connects two such hubs. Grant hub staff the `hub_operator` role with their hubs: `setUserRole { uid, role: 'hub_operator', hubIds: ['acc-01'] }`. Hub screens work with any keyboard-wedge USB/Bluetooth barcode scanner (it types the code and presses Enter); configure scanners to send Enter after each code. Linehaul drivers are ordinary driver accounts who start their shift on the van/truck named on the manifest.

## 11.6 Cloudflare
- DNS for the apex and `www` → Pages; `api` → Worker route; `ops` → admin-tools Pages project behind **Cloudflare Access**.
- WAF managed rules on; rate-limiting rule for `/geocode` (defence in depth alongside the Worker's own limiter).
- Restrict the Mapbox server token to the Geocoding/Directions scopes; rotate quarterly.

## 11.7 Rollback
- Functions: redeploy the previous git tag (`git checkout vX && firebase deploy --only functions`).
- Rules: redeploy the previous rules file from git.
- Pricing: publish the previous rule set as a new version (bookings keep their snapshot regardless).
- Pages/Worker: Cloudflare dashboard → rollback to previous deployment.
