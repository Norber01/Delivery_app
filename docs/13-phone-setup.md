# 13. Setting everything up from a phone

Everything below works in a phone browser (Chrome on Android, Safari on iPhone). Nothing needs a
computer or a terminal: GitHub's servers run the setup and deployment for you, and you only fill in
forms and copy keys.

> **Tip:** some GitHub, Google Cloud and Cloudflare settings pages are cramped on phones. If a
> button described here is missing, open the browser menu and turn on **Desktop site**.

You will set up **staging** (for testing) first. Production is the same steps again with a second
Firebase project (section 10).

**How long:** about an hour, plus 20 minutes of waiting for the first deploy.
**Costs to expect:** Google (Blaze plan, pay as you go; small at first, set a budget), Cloudflare
(free tier is enough to start; R2 asks for a card), Mapbox (free tier), Paystack (per transaction),
Hubtel SMS (per message), GitHub Actions (free for public repositories).

---

## 1. Firebase project (5 min)

1. Open **console.firebase.google.com** → **Create a project**.
2. Name it, e.g. `swiftcourier-staging`. Note the **project ID** shown under the name (you need
   nothing else from this screen). Turn Google Analytics **off** → **Create project**.
3. In the project, tap ⚙️ (Project settings) → **Usage and billing** → **Details & settings** →
   **Modify plan** → **Blaze**, and add a billing account.
4. Set a budget alert right away: **console.cloud.google.com/billing** → your billing account →
   **Budgets & alerts** → **Create budget** (an amount you are comfortable with per month,
   alerts at 50/80/100 %).

You do **not** need to turn on Firestore, Authentication, App Check etc. by hand — the deploy
does it.

## 2. A deploy key for GitHub (5 min)

GitHub needs a key that lets it set up and update your Firebase project.

1. Open **console.cloud.google.com/iam-admin/serviceaccounts** and pick your project at the top.
2. **Create service account** → name `github-deploy` → **Create and continue**.
3. **Role**: choose **Basic → Owner** → **Continue** → **Done**.
   (Owner is needed because the deploy turns on services, creates databases and grants the
   functions their own permissions. Keep this key only in GitHub.)
4. Tap the new account → **Keys** → **Add key** → **Create new key** → **JSON** → **Create**.
   A file downloads.
5. Open the file and copy **all** of its text:
   - Android: Files app → Downloads → tap the `.json` file (open with Chrome or a text viewer) →
     long-press → **Select all** → **Copy**.
   - iPhone: Files → Downloads → tap the file → share → **Copy**, or open it in a text app.
   - If your phone will not show it as text: upload it to Google Drive and open it there.
6. After step 3.2 below, **delete the downloaded file** from your phone.

> If Google says *"Service account key creation is disabled"*, your Google account belongs to an
> organisation that blocks keys. Ask its administrator to allow keys for this project (policy
> *Disable service account key creation*), or use a personal Google account for the project.

## 3. GitHub settings (10 min)

Open your repository on **github.com** → **Settings** → **Environments** → **staging**
(create it with **New environment** if it is not there).

1. Optional but recommended for **production** later: tick **Required reviewers** and add
   yourself, so nothing deploys to production without your tap.
2. Under **Environment secrets** → **Add environment secret**, add:

| Name | Value |
|---|---|
| `GCP_SA_KEY` | the whole key file text from step 2 |
| `MAPBOX_SERVER_TOKEN` | from step 4 |
| `CLOUDFLARE_API_TOKEN` | from step 5 |
| `CLOUDFLARE_ACCOUNT_ID` | from step 5 |
| `PAYSTACK_SECRET_KEY` | *later* (section 8). Without it, customers can only pay the driver. |
| `HUBTEL_SMS_CLIENT_ID`, `HUBTEL_SMS_CLIENT_SECRET` | *later* (section 9). Without them no SMS is sent. |

3. Under **Environment variables** → **Add environment variable**, add:

| Name | Example | Needed? |
|---|---|---|
| `COMPANY_NAME` | `Swift Courier GH` | yes |
| `SUPPORT_PHONE` | `+233 30 123 4567` | yes |
| `DISPATCH_PHONE` | `+233 24 000 0000` | number drivers call (defaults to SUPPORT_PHONE) |
| `MAPBOX_PUBLIC_TOKEN` | `pk.…` | for real maps in the ops app and tracking (step 4.4) |
| `DRIVER_TESTERS` | `kofi@gmail.com,ama@gmail.com` | drivers who receive the app (section 7) |
| `SMS_SENDER_ID` | `SwiftGH` | max 11 letters/digits; must be approved by Hubtel |
| `ANDROID_PACKAGE` | `gh.swiftcourier.driver` | your app's unique id; **choose once, never change** |
| `WEB_URL`, `OPS_URL`, `EDGE_URL` | `https://www.swiftcourier.com.gh` | only when you add your own domain (section 11) |

## 4. Mapbox (5 min)

1. Sign up at **account.mapbox.com**.
2. **Tokens** → **Create a token** → name `server` → leave the default scopes → no URL
   restrictions → **Create token**. Copy it into the `MAPBOX_SERVER_TOKEN` secret. This one is
   only ever used on the server.
3. In **Settings → Billing / usage**, set usage alerts.
4. After the first deploy (when you know your addresses), create a second token named `public`
   with **URL restrictions** set to your website and ops app addresses, and put it in the
   `MAPBOX_PUBLIC_TOKEN` variable. Then run the deploy again with **websites**.

## 5. Cloudflare (10 min)

1. Sign up at **dash.cloudflare.com**.
2. Open **Workers & Pages** once (this sets up your free `workers.dev` address).
3. Open **R2 Object Storage** → **Purchase R2 / Enable R2** (the free tier covers 10 GB; a card
   is required). This stores delivery photos, signatures and business documents.
4. **Account ID**: on the Workers & Pages page, tap **Account details** (or copy it from the
   address bar: `dash.cloudflare.com/<account id>/…`). Put it in `CLOUDFLARE_ACCOUNT_ID`.
5. **API token**: profile icon → **My Profile** → **API Tokens** → **Create Token** →
   **Edit Cloudflare Workers** (Use template). Then **+ Add more** and add
   *Account → Cloudflare Pages → Edit*. Account resources: your account; Zone resources:
   *All zones*. → **Continue to summary** → **Create Token**. Copy it into
   `CLOUDFLARE_API_TOKEN` (Cloudflare shows it once).

## 6. Deploy (one tap, ~20 minutes)

1. Repository → **Actions** → **Deploy** → **Run workflow** → environment **staging**, part
   **everything** → **Run workflow**.
2. Tap the run to follow it. When it ends, open the run's **Summary**: it lists what was done,
   **your website and ops app addresses**, and anything still to do.
3. If it stops, the summary says why in plain words (for example a missing setting or the Blaze
   plan). Fix it and run it again — it is always safe to re-run.

Then, once:

4. **Prices and service areas.** Review `firebase/seed/pricing-rules.sample.json` and
   `service-areas.sample.json` on GitHub (tap the file → ✏️ to edit → **Commit changes**). The
   sample prices are only examples. Then **Actions** → **Admin tasks** → **Run workflow** →
   task **seed-config**.
5. **Your owner account.** Open the website address → **Sign in** → **Create account** with your
   email → open the verification email and tap the link. Then **Admin tasks** → task
   **make-super-admin**, email = your email.
6. Open the **ops app** address, sign in, and add your phone number for two-step verification
   (you get a code by SMS each time you sign in).
7. Give staff access: they create an account on the website, then you open the ops app →
   **Staff** → enter their email, choose the role (dispatcher, hub operator, fleet manager,
   finance…) → **Give access**.

## 7. Driver app (Android)

1. In the ops app → **Fleet**, add each driver (name, phone, email) and vehicle. The page shows
   a one-time link for the driver to set their password — send it to them (WhatsApp/SMS).
2. Put the drivers' emails in the `DRIVER_TESTERS` variable (step 3.3).
3. **Actions** → **Driver app (Android)** → **Run workflow** → environment, distribution
   **phones** → **Run** (about 20–25 minutes).
4. Each driver receives an email from Firebase App Distribution: on their Android phone they tap
   **Get started** → **Download**, and allow installing from that source when asked. Later
   builds arrive the same way and install over the old version.

The first build creates the app's signing key and keeps it in your Google project (Secret
Manager → `DRIVER_UPLOAD_KEYSTORE`). Never delete it: updates must be signed with the same key.

**Security note.** Apps installed outside Google Play cannot be checked by Google's Play
Integrity, so each *phones* build carries its own App Check pass. The newest two builds stay
valid. If a phone is lost or the app leaks, delete that build's token in the Firebase console →
App Check → Apps → Android app → **Manage debug tokens**, then send a new build. For the
strongest protection, publish through Google Play's free **internal testing** track instead:
build with distribution **google-play**, download the `.aab` from the run's **Artifacts**,
create the app in **play.google.com/console** (one-time US$25 developer fee), upload it under
**Testing → Internal testing**, and invite drivers by email. In Play Console → **Test and
release → App integrity**, copy the **App signing key SHA-256** into a `PLAY_APP_SIGNING_SHA256`
variable and link the Google Cloud project for the Play Integrity API.

## 8. Online payments (Paystack)

1. Open **dashboard.paystack.com**, complete business verification (needed for live payments).
2. **Settings → API Keys & Webhooks**: copy the **Secret Key** (`sk_test_…` for staging,
   `sk_live_…` for production) into the `PAYSTACK_SECRET_KEY` secret.
3. On the same page set the **Webhook URL** to the address shown in the deploy summary
   (`…cloudfunctions.net/paystackWebhook`).
4. Run **Deploy** again (**everything**). Mobile Money and card now appear at checkout.

## 9. SMS (Hubtel)

Customers receive tracking updates and the **delivery code** by SMS; drivers need that code to
complete most deliveries, so turn SMS on before real deliveries start.

1. Open a Hubtel account and request an SMS sender ID (the `SMS_SENDER_ID` variable).
2. Copy the SMS API **Client ID** and **Client Secret** into `HUBTEL_SMS_CLIENT_ID` and
   `HUBTEL_SMS_CLIENT_SECRET`, then run **Deploy** (**backend**).

## 10. Production

Repeat sections 1–3 with a second Firebase project (e.g. `swiftcourier-prod`) and a GitHub
environment called **production** (with **Required reviewers**), then run the workflows with
environment **production**. Production also gets point-in-time recovery and daily backups
automatically. Use the live Paystack key there.

## 11. Your own domain (optional)

1. Add your domain to Cloudflare (**Websites → Add a domain**) and follow its steps to change the
   name servers at your registrar.
2. **Workers & Pages** → the `…-web` project → **Custom domains** → add `www.yourdomain.com.gh`
   (and the `…-ops` project → `ops.yourdomain.com.gh`).
3. Set the variables `WEB_URL` / `OPS_URL` to those addresses and run **Deploy** (**everything**):
   sign-in, bot protection and the edge Worker are updated for the new addresses.
4. Protect the ops app with **Cloudflare Zero Trust → Access → Applications** (only staff emails).

## 12. After the first day of real use

Firebase console → **App Check** → **APIs**: tap **Cloud Firestore** and **Realtime Database**
→ **Enforce**. (The backend functions already require App Check.) Check the console's App Check
metrics first: almost all requests should show as *verified*.

---

### What the workflows do (for reference)

| Workflow | Does |
|---|---|
| **CI** | runs all tests and builds on every change |
| **Deploy** | creates anything missing in Google/Firebase/Cloudflare, sets secrets (random ones generated), deploys rules, functions, Worker, website and ops app |
| **Admin tasks** | `seed-config` (prices, areas, hubs), `make-super-admin` |
| **Driver app (Android)** | builds, signs and sends the driver app |
