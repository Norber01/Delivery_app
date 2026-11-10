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
   firebase functions:secrets:set IP_HASH_SALT --project <id>     # 32+ random bytes
   ```
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

## 11.5 Cloudflare
- DNS for the apex and `www` → Pages; `api` → Worker route; `ops` → admin-tools Pages project behind **Cloudflare Access**.
- WAF managed rules on; rate-limiting rule for `/geocode` (defence in depth alongside the Worker's own limiter).
- Restrict the Mapbox server token to the Geocoding/Directions scopes; rotate quarterly.

## 11.6 Rollback
- Functions: redeploy the previous git tag (`git checkout vX && firebase deploy --only functions`).
- Rules: redeploy the previous rules file from git.
- Pricing: publish the previous rule set as a new version (bookings keep their snapshot regardless).
- Pages/Worker: Cloudflare dashboard → rollback to previous deployment.
