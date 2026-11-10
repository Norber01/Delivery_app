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
- Amount mismatch, currency mismatch, or unknown reference → payment `flagged`, finance alerted, booking not confirmed.
- A scheduled **reconciliation** job re-verifies all `pending` payments older than 15 minutes and compares daily settlement reports.
- Refunds are created by `finance` via `refundPayment`, capped at the captured amount minus previous refunds, executed via provider API, and recorded only after provider confirmation.
- Secrets (`PAYSTACK_SECRET_KEY`, `HUBTEL_CLIENT_SECRET`) live in Google Secret Manager via `defineSecret`, never in client code or the repo.

## 7.4 Cash and invoices
- **Cash on pickup**: driver records collection in app; amount must equal booking total; reconciled at end of shift against hub cash deposit by finance (`driverCashLedger`, Phase 3).
- **Business invoice**: only for verified businesses with approved `creditTerms`; monthly invoice generated (Phase 5), credit limit enforced at booking time.
