# 10. Security Plan

## 10.1 Identity & access
- Firebase Authentication: email/password + phone OTP for customers; staff accounts created by admins only; drivers sign in on company-registered devices.
- **Admin MFA**: staff roles must enrol TOTP/SMS second factor (Identity Platform MFA). `requireStaff()` checks `auth.token.firebase.sign_in_second_factor` and rejects otherwise.
- Roles via custom claims set only by `setUserRole` (super_admin, MFA) — see `03-roles-permissions.md`.
- Ops app additionally behind Cloudflare Access (company identity provider).

## 10.2 Data protection
- Firestore rules: deny-by-default; server-owned collections not writable by any client; reads restricted to owner/business/scope.
- RTDB rules: drivers write only their own node and only during an active shift; no customer reads.
- R2: private buckets, uploads/downloads via short-lived signed URLs after server authorization.
- Personal data minimisation: guest contact data pseudonymised after retention period; IPs stored only as salted hashes.
- Compliance: register with Ghana's Data Protection Commission (Act 843); publish privacy notice covering location tracking of drivers and customer data use.

## 10.3 Application security
- All business mutations in Cloud Functions with zod validation (`packages/validation`).
- App Check enforced on callables (`enforceAppCheck: true`), Firestore and RTDB.
- Rate limiting: Cloudflare rules at the edge + Firestore fixed-window counters per uid/IP-hash in functions (`lib/rateLimit.ts`).
- Payment webhooks: signature verification + server-side verify call + idempotency (see `07-payments.md`).
- Protected records: prices, payments, custody events, POD, audit logs are server-written; tracking events and audit logs are append-only.
- Secrets in Google Secret Manager (`defineSecret`) and Cloudflare Worker secrets; `.env*` files git-ignored; Mapbox public token for GL JS is URL-restricted to company domains; server token is secret.
- Dependency hygiene: lockfile committed, `pnpm audit` in CI, Dependabot.
- CSP headers on Pages (`apps/web/public/_headers`).

## 10.4 Audit logging
`auditLogs` written by `writeAudit()` for: role changes, pricing publication, booking creation, cancellations, assignments, refunds, manual payment confirmations, POD overrides, configuration changes. Not readable by non-admins, never updated or deleted by app code.

## 10.5 Backup & recovery
- Firestore **PITR** enabled (7-day point-in-time recovery) + daily scheduled managed exports to a separate GCS bucket in another project with retention lock (30 days daily, 12 monthly).
- RTDB: no backup required (ephemeral); daily backups optional.
- R2: object versioning for evidence bucket; lifecycle rules per retention table.
- Recovery runbook: quarterly restore drill into staging; RPO ≤ 24 h (exports) / minutes (PITR); RTO ≤ 4 h.

## 10.6 Monitoring & incident response
- Cloud Logging alerts on function error rate, webhook verification failures, rate-limit spikes, role changes.
- Firebase/Cloudflare/Mapbox budget alerts (see `12-cost-control.md`).
- Incident runbook: rotate secrets, revoke tokens (`revokeRefreshTokens`), disable compromised accounts, notify Data Protection Commission where required.
