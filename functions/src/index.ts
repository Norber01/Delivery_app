import { FIREBASE_REGION, ROLES, type Role } from '@courier/constants';
import { MapboxProvider } from '@courier/shared-utils';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret, defineString } from 'firebase-functions/params';
import { onDocumentCreated } from 'firebase-functions/v2/firestore';
import { onCall, onRequest, type CallableRequest } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { callerFromToken, requireRole } from './lib/auth.js';
import { AppError, toHttpsError } from './lib/errors.js';
import { hashIp, randomId } from './lib/hash.js';
import { HubtelSmsProvider, type SmsProvider } from './notifications/sms.js';
import { PaystackProvider } from './payments/paystack.js';
import { claimBooking as claimBookingService, completeSignUp as completeSignUpService, type IdentityPort } from './services/accountService.js';
import { authorizeRoleChange, publishPricingRules as publishPricingRulesService } from './services/adminService.js';
import { createBooking as createBookingService } from './services/bookingService.js';
import { deliverNotification } from './services/notificationService.js';
import {
  getPaymentStatus as getPaymentStatusService,
  handlePaymentWebhook,
  initiatePayment as initiatePaymentService,
  reconcilePayments as reconcilePaymentsService,
  type PaymentDeps,
} from './services/paymentService.js';
import { getQuote as getQuoteService, type RequestMeta, type ServiceDeps } from './services/quoteService.js';
import { handleRefundEvent, reconcileRefunds, requestRefund } from './services/refundService.js';
import { getTrackingView as getTrackingViewService } from './services/trackingService.js';
import { FirestoreRateLimiter, FirestoreStore } from './store/firestoreStore.js';
import type { NotificationRecord } from './store/types.js';

initializeApp();
setGlobalOptions({ region: FIREBASE_REGION, maxInstances: 20 });

// ---- Configuration (non-secret params + Secret Manager secrets) -------------
const PUBLIC_SITE_URL = defineString('PUBLIC_SITE_URL', { description: 'Public website origin, e.g. https://www.example.com.gh' });
const COMPANY_NAME = defineString('COMPANY_NAME', { default: 'Courier' });
const PAYMENT_FALLBACK_EMAIL_DOMAIN = defineString('PAYMENT_FALLBACK_EMAIL_DOMAIN', {
  description: 'Company-controlled domain for checkout emails when a customer gives none',
});
const SMS_SENDER_ID = defineString('SMS_SENDER_ID', { default: 'Courier' });

const MAPBOX_SERVER_TOKEN = defineSecret('MAPBOX_SERVER_TOKEN');
const IP_HASH_SALT = defineSecret('IP_HASH_SALT');
const PAYSTACK_SECRET_KEY = defineSecret('PAYSTACK_SECRET_KEY');
const HUBTEL_SMS_CLIENT_ID = defineSecret('HUBTEL_SMS_CLIENT_ID');
const HUBTEL_SMS_CLIENT_SECRET = defineSecret('HUBTEL_SMS_CLIENT_SECRET');

const db = getFirestore();
// Optional fields normalise to undefined (see validation `optional`); omit them rather than fail.
db.settings({ ignoreUndefinedProperties: true });
const store = new FirestoreStore(db);
const rateLimiter = new FirestoreRateLimiter(db);

const site = () => ({
  publicUrl: PUBLIC_SITE_URL.value().replace(/\/$/, ''),
  companyName: COMPANY_NAME.value(),
  fallbackEmailDomain: PAYMENT_FALLBACK_EMAIL_DOMAIN.value(),
});

let maps: MapboxProvider | null = null;
function deps(): ServiceDeps {
  const token = MAPBOX_SERVER_TOKEN.value();
  if (!maps && token) maps = new MapboxProvider(token);
  return { store, rateLimiter, maps, now: () => new Date(), newId: () => randomId() };
}

let paystack: PaystackProvider | null = null;
function paymentDeps(): PaymentDeps {
  paystack ??= new PaystackProvider(PAYSTACK_SECRET_KEY.value());
  return { store, rateLimiter, provider: paystack, now: () => new Date(), site: site() };
}

/** Secrets that hold this placeholder are treated as "not configured". */
const configured = (v: string) => Boolean(v) && v !== 'unset';

function meta(req: CallableRequest): RequestMeta {
  const ip = req.rawRequest.ip;
  return { ipHash: ip ? hashIp(ip, IP_HASH_SALT.value()) : null };
}

/** Wrap a callable handler: App Check enforced, domain errors mapped to HttpsError. */
function callable<T>(
  secrets: ReturnType<typeof defineSecret>[],
  handler: (req: CallableRequest) => Promise<T>,
) {
  return onCall({ enforceAppCheck: true, secrets: [IP_HASH_SALT, ...secrets], memory: '256MiB' }, async (req) => {
    try {
      return await handler(req);
    } catch (e) {
      throw toHttpsError(e);
    }
  });
}

// ---- Booking & pricing (Phase 1) ---------------------------------------------

/** Price a shipment. Open to guests (App Check + rate limit). */
export const getQuote = callable([MAPBOX_SERVER_TOKEN], (req) =>
  getQuoteService(deps(), req.data, callerFromToken(req.auth), meta(req)),
);

/** Turn a quote into a booking. Open to guests (App Check + rate limit). */
export const createBooking = callable([], (req) =>
  createBookingService(
    { store, rateLimiter, now: () => new Date(), site: site() },
    req.data,
    callerFromToken(req.auth),
    meta(req),
  ),
);

/** Publish a new pricing version (admin, MFA). */
export const publishPricingRules = callable([], (req) => publishPricingRulesService(store, callerFromToken(req.auth), req.data));

/** Assign a role via custom claims (admin/super_admin, MFA). */
export const setUserRole = callable([], async (req) => {
  const caller = callerFromToken(req.auth);
  requireRole(caller, ['admin', 'super_admin']); // before any lookup, so non-admins learn nothing
  const auth = getAuth();
  const target = await auth.getUser(String((req.data as { uid?: unknown })?.uid ?? '')).catch(() => {
    throw new AppError('VALIDATION_FAILED', 'User not found.', 'not-found');
  });
  const currentRole = (ROLES as readonly string[]).includes(target.customClaims?.role as string)
    ? (target.customClaims!.role as Role)
    : null;
  const input = authorizeRoleChange(caller, req.data, currentRole);
  const claims = {
    role: input.role,
    ...(input.businessId ? { businessId: input.businessId } : {}),
    ...(input.hubIds ? { hubIds: input.hubIds } : {}),
  };
  await auth.setCustomUserClaims(input.uid, claims);
  await auth.revokeRefreshTokens(input.uid);
  await db.collection('users').doc(input.uid).set(
    { uid: input.uid, role: input.role, businessId: input.businessId ?? null, updatedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  await store.writeAudit({
    actorUid: caller.uid,
    actorRole: caller.role ?? 'guest',
    action: 'user.setRole',
    targetType: 'user',
    targetId: input.uid,
    before: { role: currentRole },
    after: claims,
    ipHash: meta(req).ipHash,
  });
  return { ok: true };
});

// ---- Payments (Phase 2) ----------------------------------------------------------

/** Start a hosted checkout (Mobile Money / card) for a booking's confirmed total. */
export const initiatePayment = callable([PAYSTACK_SECRET_KEY], (req) =>
  initiatePaymentService(paymentDeps(), req.data, callerFromToken(req.auth), meta(req)),
);

/** Payment status from the database (re-verified with the provider while pending). */
export const getPaymentStatus = callable([PAYSTACK_SECRET_KEY], (req) =>
  getPaymentStatusService(paymentDeps(), req.data, callerFromToken(req.auth), meta(req)),
);

/** Refund a captured payment (finance/admin, MFA). */
export const refundPayment = callable([PAYSTACK_SECRET_KEY], (req) => requestRefund(paymentDeps(), callerFromToken(req.auth), req.data));

/** Paystack webhook. Signature-verified, then every event is re-verified via the Paystack API. */
export const paystackWebhook = onRequest({ secrets: [PAYSTACK_SECRET_KEY], memory: '256MiB', maxInstances: 10 }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).send('method not allowed');
    return;
  }
  try {
    const d = paymentDeps();
    const result = await handlePaymentWebhook(d, req.rawBody, req.headers, (e) => handleRefundEvent(d, e));
    res.status(result.status).send(result.body);
  } catch (e) {
    // Non-2xx makes Paystack retry later; processing is idempotent.
    console.error('Webhook processing failed', e);
    res.status(500).send('retry');
  }
});

/** Safety net for delayed or missed webhooks: re-verify pending payments and refunds. */
export const reconcilePayments = onSchedule(
  { schedule: 'every 15 minutes', secrets: [PAYSTACK_SECRET_KEY], timeoutSeconds: 300 },
  async () => {
    const d = paymentDeps();
    const payments = await reconcilePaymentsService(d);
    const refunds = await reconcileRefunds(d);
    console.log('Reconciliation', { payments, refunds });
  },
);

// ---- Tracking & accounts (Phase 2) ------------------------------------------

/** Public tracking (tracking number) or full view (owner session / guest access code). */
export const getTrackingView = callable([], (req) =>
  getTrackingViewService({ store, rateLimiter }, req.data, callerFromToken(req.auth), meta(req)),
);

const identity: IdentityPort = {
  async getUser(uid) {
    const u = await getAuth().getUser(uid);
    return { email: u.email ?? null, phone: u.phoneNumber ?? null, emailVerified: u.emailVerified, claims: u.customClaims ?? {} };
  },
  async setClaims(uid, claims) {
    await getAuth().setCustomUserClaims(uid, claims);
  },
};

/** First sign-in: grant the customer role (only to accounts without a role) and create the profile. */
export const completeSignUp = callable([], (req) => completeSignUpService({ store, identity }, callerFromToken(req.auth), req.data));

/** Attach a guest booking to the signed-in customer using its access code. */
export const claimBooking = callable([], (req) => claimBookingService({ store }, callerFromToken(req.auth), req.data));

// ---- Notifications --------------------------------------------------------------

/** Sends each queued SMS once; retried by the platform on transient failure (max 3 attempts). */
export const sendNotification = onDocumentCreated(
  { document: 'notifications/{id}', secrets: [HUBTEL_SMS_CLIENT_ID, HUBTEL_SMS_CLIENT_SECRET], retry: true },
  async (event) => {
    if (!event.data) return;
    const n = { ...(event.data.data() as Omit<NotificationRecord, 'id'>), id: event.params.id };
    const id = HUBTEL_SMS_CLIENT_ID.value();
    const secret = HUBTEL_SMS_CLIENT_SECRET.value();
    const sms: SmsProvider | null =
      configured(id) && configured(secret) ? new HubtelSmsProvider(id, secret, SMS_SENDER_ID.value()) : null;
    await deliverNotification({ store, sms }, n);
  },
);
