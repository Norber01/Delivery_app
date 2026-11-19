# Ops app

Internal React + Vite app for staff, deployed to a separate hostname behind Cloudflare Access.
Staff sign in with email + password **and a second factor** (SMS or authenticator app); accounts
without one are taken to enrolment first. The backend independently requires MFA for every staff action.

- **Dispatch** (`dispatcher`, `admin`, `super_admin`): live board (needs driver / in progress /
  exceptions, delayed filter), map of drivers on shift, ranked driver choice, all dispatch actions,
  timeline with internal notes, proof of delivery (signature, photo via short-lived URL).
- **Fleet** (`fleet_manager`, `admin`, `super_admin`): drivers (created with a set-password link) and vehicles.

Finance, hub and analytics screens arrive in later phases.

```bash
pnpm --filter @courier/admin-tools dev   # http://localhost:5174 (see .env.example)
pnpm --filter @courier/admin-tools test
```
