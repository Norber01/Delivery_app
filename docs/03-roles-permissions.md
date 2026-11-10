# 3. User Roles & Permission Matrix

## 3.1 Roles

Roles are stored in Firebase Auth **custom claims** (`{ role, businessId?, hubIds?, mfa? }`). Only the `setUserRole` Cloud Function (callable by `super_admin`, MFA required) or the bootstrap script can set claims. Every change writes an `auditLogs` entry. Users cannot write their own `users/{uid}.role` — the field is server-written and is not trusted by rules anyway.

| Role | Description | MFA |
|---|---|---|
| `guest` | Not signed in. Can quote, book, and track with tracking number + access token | – |
| `customer` | Individual account | Optional |
| `business_owner` | Owner of a verified business account | Recommended |
| `business_staff` | Staff member of a business, created by owner | Optional |
| `driver` | Company-employed driver | Device-bound + PIN |
| `hub_operator` | Scans parcels in/out at assigned hubs, builds manifests | Required |
| `dispatcher` | Assigns drivers/vehicles, manages exceptions in assigned service areas | Required |
| `fleet_manager` | Vehicles, maintenance, fuel | Required |
| `finance` | Payments, refunds, invoices, expenses, reports | Required |
| `admin` | Configuration (pricing, areas, hubs, routes), staff management except role elevation to admin | Required |
| `super_admin` | Role assignment, security settings. Max 2–3 people | Required (hardware key recommended) |

## 3.2 Permission matrix

Legend: **C** create · **R** read · **U** update · **D** delete/cancel · `own` limited to own records · `scope` limited to assigned hubs/areas · `fn` via Cloud Function only · – none

| Resource | guest | customer | business_owner | business_staff | driver | hub_operator | dispatcher | fleet_manager | finance | admin | super_admin |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Quote | C fn | C fn | C fn (contract) | C fn (contract) | – | – | C fn | – | – | C fn | C fn |
| Booking (deliveryRequest) | C fn; R with token | C fn; R own; D own (before pickup) fn | C fn; R business; D fn | C fn; R business | – | R scope | R scope; U fn | – | R | R | R |
| Bulk/CSV booking | – | – | C fn | C fn | – | – | – | – | – | – | – |
| Delivery & legs | – | R own (public view) | R business (public view) | R business (public view) | R assigned | R scope; U fn (scan) | R scope; U fn | – | R | R | R |
| Assignment | – | – | – | – | R own; U fn (accept/start/complete) | – | C/U/D fn scope | – | – | R | R |
| Tracking events | R public msgs with token | R public msgs own | R public msgs business | R public msgs business | C fn (own leg) | C fn (scan) | C fn | – | R | R | R |
| Driver live location | – | R fn (active, own delivery only) | R fn (active, own delivery only) | same | W own node | R scope | R all | R | – | R | R |
| Proof of delivery | – | R own (summary) | R business (summary) | R business | C fn (own leg) | – | R | – | R | R | R |
| Payments | – | R own | R business | R business (if permitted) | – | – | R status | – | R; refund fn | R | R |
| Invoices | – | – | R business | R (if permitted) | – | – | – | – | C/U fn | R | R |
| Expenses | – | – | – | – | C fn (fuel, own) | – | – | C fn | C/U fn, approve | R | R |
| Vehicles, maintenance | – | – | – | – | R assigned | R | R | C/U fn | R | C/U fn | C/U fn |
| Hubs, routes, service areas | R public subset | R public subset | R public subset | R public subset | R | R | R | R | R | C/U fn | C/U fn |
| Pricing rules | – | – | – | – | – | – | R | – | R | C/publish fn | C/publish fn |
| Business verification | – | C request fn | U own profile fn | – | – | – | – | – | R | approve fn | approve fn |
| Staff/driver accounts | – | – | add business_staff fn | – | – | – | – | – | – | C fn (non-admin roles) | C fn any role |
| Role claims | – | – | – | – | – | – | – | – | – | – | set fn |
| Support tickets | C fn (with tracking + token) | C/R own | C/R business | C/R business | – | – | R/U | – | R/U (billing) | R/U | R/U |
| Audit logs | – | – | – | – | – | – | – | – | R (finance actions) | R | R |

## 3.3 Enforcement layers

1. **Cloudflare**: WAF, bot management, rate limits; Access in front of the ops app.
2. **App Check**: callable functions set `enforceAppCheck: true`; Firestore/RTDB App Check enforcement turned on in console.
3. **Cloud Functions**: `requireRole(context, [...roles])`, `requireMfa` for staff, scope checks (hubIds/serviceAreaIds/businessId), schema validation.
4. **Security Rules**: deny-by-default; clients have read-only access to their own records and **no** write access to server-owned collections (`deliveryRequests`, `deliveries`, `payments`, `pricingRules`, `auditLogs`, …).
5. **Audit logs** for every privileged mutation.

## 3.4 Privilege-escalation safeguards

- No client-writable field is ever used for authorization.
- `setUserRole` refuses to change the caller's own role and refuses to create a `super_admin` unless two super admins exist (break-glass requires the bootstrap script with service-account access, which is logged in Cloud Audit Logs).
- Admins cannot grant `admin` or `super_admin`.
- Token revocation (`revokeRefreshTokens`) is called on every role change so stale claims expire immediately.
