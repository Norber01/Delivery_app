# 7. Payment Integration Architecture

## 7.1 Provider evaluation

| Criterion | Paystack (Ghana) | Hubtel | Others (Flutterwave, ExpressPay, direct MNO APIs) |
|---|---|---|---|
| Mobile Money (MTN MoMo, Telecel Cash, AirtelTigo Money) | Yes | Yes | Varies |
| Cards (Visa/Mastercard) | Yes | Yes | Flutterwave yes |
| Webhook authenticity | HMAC-SHA512 signature (`x-paystack-signature`) over raw body with secret key | Callback to merchant URL; authenticate by **re-querying transaction status API** | Varies |
| Server-side verify endpoint | `GET /transaction/verify/:reference` | Transaction status check API | Varies |
| Refund API | Yes | Yes (via reversal/refund flows) | Varies |
| Developer docs & SDK maturity | Strong, well-documented | Good, Ghana-focused, also SMS | Varies |
| Settlement | To Ghanaian bank account | To Ghanaian bank / Hubtel balance | Varies |
| Bundled SMS | No | Yes (Hubtel SMS) | – |

**Recommendation:** Paystack as primary checkout (cards + MoMo, signed webhooks, verify API, mature refunds); Hubtel as secondary/fallback and as the SMS provider candidate. Fees, settlement times and KYB requirements change — confirm current commercial terms with both providers before signing. Direct MNO integrations are not recommended initially (multiple contracts, higher compliance burden).

## 7.2 Provider abstraction

```ts
interface PaymentProvider {
  initialize(p: { reference; amountPesewas; email?; phone?; channel; metadata }): Promise<{ authorizationUrl?; providerReference; status }>;
  verify(reference: string): Promise<VerifiedTransaction>;       // authoritative
  verifyWebhook(rawBody: Buffer, headers): WebhookEvent | null;   // signature check
  refund(p: { providerReference; amountPesewas; reason }): Promise<RefundResult>;
}
```

## 7.3 Flow

```mermaid
sequenceDiagram
  participant W as Web/App
  participant F as Functions
  participant P as Provider
  participant DB as Firestore
  W->>F: initiatePayment(requestId)
  F->>DB: load booking; amount = booking.price.totalPesewas (never from client)
  F->>DB: payments/{provider_ref} status=initiated
  F->>P: initialize(reference, amount)
  F-->>W: authorizationUrl / MoMo prompt
  P-->>F: webhook (signed)
  F->>F: verify signature (Paystack) — reject otherwise
  F->>P: verify(reference)   (always, both providers)
  F->>F: check amount, currency, reference ↔ booking
  F->>DB: txn: paymentEvents/{id} (idempotent), payments → succeeded, booking paymentStatus=paid, status=confirmed, auditLogs
  W->>F: getPaymentStatus (poll) → shows result from DB only
```

Rules:
- The client redirect/return page **never** marks anything paid; it only polls the server.
- Webhook handlers are idempotent (`paymentEvents/{provider_eventId}` created with `create()`; duplicates exit early).
- Amount, currency or reference mismatch → payment `flagged` with a `reviewReason`, audit entry, booking not confirmed. Webhooks for unknown references are acknowledged and logged as errors (set a Cloud Logging alert on them).
- A scheduled **reconciliation** job re-verifies all `pending` payments older than 15 minutes. Comparing the provider's daily settlement reports with the ledger is planned for the finance tools (Phase 6 analytics).
- Refunds are created by `finance` via `refundPayment`, capped at the captured amount minus previous refunds, executed via provider API, and recorded only after provider confirmation.
- Secrets (`PAYSTACK_SECRET_KEY`, `HUBTEL_CLIENT_SECRET`) live in Google Secret Manager via `defineSecret`, never in client code or the repo.

## 7.4 Cash and invoices
- **Cash on pickup**: driver records collection in app; amount must equal booking total; reconciled at end of shift against hub cash deposit by finance (`driverCashLedger`, Phase 3).
- **Business invoice**: only for verified businesses with approved `creditTerms`; monthly invoice generated (Phase 5), credit limit enforced at booking time.

## 7.5 Implementation status (Phase 2)

| Item | Status |
|---|---|
| `PaymentProvider` port | `functions/src/payments/provider.ts` |
| Paystack adapter (initialize, verify, webhook HMAC-SHA512, refund, refund status) | Implemented and unit-tested against recorded API shapes; exercised end-to-end against a local Paystack stand-in. **Must be run against Paystack test keys before go-live.** |
| Hubtel payments adapter | Not implemented. The port allows adding it; Hubtel callbacks are unsigned, so the adapter must rely solely on its status-check API. |
| `initiatePayment` | Amount always taken from the stored booking; payment record written before the provider is called; reference `TRACKINGNUMBER-xxxxxxxx`. |
| `paystackWebhook` | Signature check → re-verify via API → atomic, idempotent update keyed by `paymentEvents/{event}`. Unknown references are acknowledged and logged. |
| `getPaymentStatus` | Reads the database; re-verifies a pending payment with the provider at most every 20 s per payment (covers delayed webhooks). |
| `reconcilePayments` (every 15 min) | Re-verifies pending payments older than 15 min; expires attempts older than 24 h; settles pending refunds. |
| Amount / currency / reference mismatch | Payment `flagged` (`reviewReason`), booking **not** credited, audit entry. |
| Second successful payment / payment on cancelled booking | Payment `succeeded` with `reviewReason` for finance to refund; booking not double-credited. |
| `refundPayment` (finance/admin + MFA) | Atomically reserves the amount (`refundPendingPesewas`) so concurrent refunds cannot exceed the capture; settles from provider-confirmed status only; reservation released if the provider rejects. |
| Finance UI | Not yet built (ops app); refunds are available through the callable. |

**Paystack configuration:** set the webhook URL in the Paystack dashboard to the deployed `paystackWebhook` HTTPS URL; enable the Mobile Money and card channels for GHS; store the secret key with `firebase functions:secrets:set PAYSTACK_SECRET_KEY`. Customers without an email address get a placeholder `booking+<tracking>@PAYMENT_FALLBACK_EMAIL_DOMAIN` because Paystack requires an email — use a domain the company controls.
