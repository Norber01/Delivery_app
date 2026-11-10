import { FIREBASE_REGION, ROLES, type Role } from '@courier/constants';
import { MapboxProvider } from '@courier/shared-utils';
import { initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { FieldValue, getFirestore } from 'firebase-admin/firestore';
import { setGlobalOptions } from 'firebase-functions/v2';
import { defineSecret } from 'firebase-functions/params';
import { onCall, type CallableRequest } from 'firebase-functions/v2/https';
import { callerFromToken, requireRole } from './lib/auth.js';
import { AppError, toHttpsError } from './lib/errors.js';
import { hashIp, randomId } from './lib/hash.js';
import { authorizeRoleChange, publishPricingRules as publishPricingRulesService } from './services/adminService.js';
import { createBooking as createBookingService } from './services/bookingService.js';
import { getQuote as getQuoteService, type RequestMeta, type ServiceDeps } from './services/quoteService.js';
import { FirestoreRateLimiter, FirestoreStore } from './store/firestoreStore.js';

initializeApp();
setGlobalOptions({ region: FIREBASE_REGION, maxInstances: 20 });

const MAPBOX_SERVER_TOKEN = defineSecret('MAPBOX_SERVER_TOKEN');
const IP_HASH_SALT = defineSecret('IP_HASH_SALT');

const db = getFirestore();
const store = new FirestoreStore(db);
const rateLimiter = new FirestoreRateLimiter(db);

let maps: MapboxProvider | null = null;
function deps(): ServiceDeps {
  const token = MAPBOX_SERVER_TOKEN.value();
  if (!maps && token) maps = new MapboxProvider(token);
  return { store, rateLimiter, maps, now: () => new Date(), newId: () => randomId() };
}

function meta(req: CallableRequest): RequestMeta {
  const ip = req.rawRequest.ip;
  return { ipHash: ip ? hashIp(ip, IP_HASH_SALT.value()) : null };
}

const publicCallable = { enforceAppCheck: true, secrets: [MAPBOX_SERVER_TOKEN, IP_HASH_SALT], memory: '256MiB' as const };

/** Price a shipment. Open to guests (App Check + rate limit). */
export const getQuote = onCall(publicCallable, async (req) => {
  try {
    return await getQuoteService(deps(), req.data, callerFromToken(req.auth), meta(req));
  } catch (e) {
    throw toHttpsError(e);
  }
});

/** Turn a quote into a booking. Open to guests (App Check + rate limit). */
export const createBooking = onCall(publicCallable, async (req) => {
  try {
    return await createBookingService(deps(), req.data, callerFromToken(req.auth), meta(req));
  } catch (e) {
    throw toHttpsError(e);
  }
});

/** Publish a new pricing version (admin, MFA). */
export const publishPricingRules = onCall({ enforceAppCheck: true }, async (req) => {
  try {
    return await publishPricingRulesService(store, callerFromToken(req.auth), req.data);
  } catch (e) {
    throw toHttpsError(e);
  }
});

/** Assign a role via custom claims (admin/super_admin, MFA). */
export const setUserRole = onCall({ enforceAppCheck: true, secrets: [IP_HASH_SALT] }, async (req) => {
  try {
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
  } catch (e) {
    throw toHttpsError(e);
  }
});
