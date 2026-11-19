# 14. Card-free demo

A complete, clickable version of the platform that runs **entirely in the visitor's browser** —
no Firebase, Cloudflare, Mapbox, Paystack or SMS accounts, and no bank card. It is meant for
showing the product to a client before the real services are set up.

**Address:** `https://<github-user>.github.io/<repository>/` (website) and `…/ops/` (operations app).

## What is real and what is simulated

| Real (the production code) | Simulated in the browser |
|---|---|
| Pricing, quotes, bookings, tracking, dispatch rules, driver actions and delivery codes, hubs and manifests, business accounts, bulk CSV, invoices, route planning, fleet, expenses, driver pay, cash control, the finance report and its checks | The database (saved in the browser, shared between the website and ops app tabs), sign-in (sample accounts; phone codes are always 123456), text messages (shown in the demo bar instead of sent), GPS (drivers move toward their next stop), address search (about 30 well-known places), uploaded photos/documents (kept in the browser) |

Not in the demo: online payment (customers choose "pay the driver"), the Android driver app
(played on the ops app's **Driver phone (demo)** page), and anything shared between different
visitors — each browser has its own copy of the sample data. **Reset** in the demo bar starts over.

## Showing it to a client (5 minutes)

1. Open the website → **Book a delivery** (search "oxford" and "madina") → confirm with "pay the driver".
2. In the demo bar: **Sign in as… → Akosua Owusu** (owner). The ops app opens.
3. **Dispatch** → the new booking → assign **Kwame Mensah**. **Routes** → plan his run.
4. **Driver phone (demo)** → Kwame → *Start* → *Scan label & collect* → enter the code shown → *Complete delivery*.
5. In another tab: the website's **Track** page for that parcel shows each step.
6. **Analytics** → the month's revenue, costs and the six reconciliation checks; **Driver pay**, **Expenses**, **Fleet** show the sample history.
7. **Sign in as… → Adwoa Frimpong** for the business dashboard (bulk upload, invoices, reports).

## Publishing (one time, from a phone)

1. GitHub → repository → **Settings → Pages** → *Build and deployment* → Source: **GitHub Actions**.
2. Optional: repository variable `DEMO_COMPANY_NAME` (e.g. your client's company name) and `DEMO_SUPPORT_PHONE`.
3. **Actions → Demo site → Run workflow** (it also runs automatically on every change to `main`).
   The run's summary shows the address.

The repository must stay **public** for free GitHub Pages; the demo contains no secrets.

## How it works (for developers)

`packages/demo-backend` replaces `firebase/*` and `firebase-admin/firestore` at build time
(`VITE_DEMO=true`, see `deploy/build-demo.sh`). The real Cloud Functions services and Firestore
store classes run unchanged against an in-browser database; the same database code passes the
Firestore emulator integration tests (`pnpm --filter @courier/demo-backend test`). The sample data
is created on first visit by calling the real services with the clock set to past dates.
Browser test of the built demo: `packages/demo-backend/e2e/demo.e2e.cjs`.
