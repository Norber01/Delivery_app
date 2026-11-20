import { BULK, type Role } from '@courier/constants';
import type { AddressBookEntry, BusinessDoc, UploadTicket } from '@courier/shared-types';
import { evidenceUrl } from '@courier/shared-utils';
import {
  addressBookEntrySchema,
  businessDocumentUploadSchema,
  contractPricingSchema,
  creditTermsSchema,
  inviteStaffSchema,
  issuesToFieldErrors,
  registerBusinessSchema,
  reviewBusinessSchema,
} from '@courier/validation';
import { requireRole, type Caller } from '../lib/auth.js';
import { AppError } from '../lib/errors.js';
import { randomId } from '../lib/hash.js';
import type { EvidenceStore, OpsStore } from '../ops/types.js';
import type { BusinessIdentityPort, BusinessStore } from './types.js';

export interface BusinessDeps {
  biz: BusinessStore;
  ops: OpsStore;
  evidence: EvidenceStore;
  identity: BusinessIdentityPort;
  uploads: { workerUrl: string; secret: string };
  now: () => Date;
  newId: () => string;
}

const BUSINESS_ROLES: Role[] = ['business_owner', 'business_staff'];
const REVIEW_ROLES: Role[] = ['manager', 'admin', 'super_admin'];
const CREDIT_ROLES: Role[] = ['finance', 'manager', 'admin', 'super_admin'];

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: import('zod').ZodError } }, raw: unknown, msg = 'Please check the highlighted fields.'): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new AppError('VALIDATION_FAILED', msg, 'invalid-argument', issuesToFieldErrors(r.error));
  return r.data;
}

/** The caller's own business (owner or staff), or a refusal. */
export async function callerBusiness(deps: Pick<BusinessDeps, 'biz'>, caller: Caller, roles: Role[] = BUSINESS_ROLES): Promise<BusinessDoc> {
  requireRole(caller, roles);
  const b = caller.businessId ? await deps.biz.getBusiness(caller.businessId) : null;
  const member = b && (b.ownerUid === caller.uid || b.staffUids.includes(caller.uid));
  if (!b || !member) throw new AppError('PERMISSION_DENIED', 'You are not a member of this business.', 'permission-denied');
  return b;
}

// ---- Registration -----------------------------------------------------------------------------

/** Signed URL for a registration document (certificate of incorporation, TIN certificate). */
export async function requestBusinessDocumentUpload(deps: BusinessDeps, caller: Caller, raw: unknown): Promise<UploadTicket> {
  requireRole(caller, ['customer', 'business_owner']);
  const input = parse(businessDocumentUploadSchema, raw);
  const ext = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf' }[input.contentType];
  const key = `kyb/${caller.uid}/${randomId(20)}.${ext}`;
  const expires = Math.floor(deps.now().getTime() / 1000) + 15 * 60;
  // Upload tickets are shared with POD photos; the "delivery" scope here is the applicant.
  await deps.ops.createUploadTicket({ key, deliveryId: `kyb:${caller.uid}`, driverUid: caller.uid, contentType: input.contentType, maxBytes: input.bytes, expiresAt: new Date(expires * 1000) });
  return {
    key,
    uploadUrl: await evidenceUrl(deps.uploads.workerUrl, deps.uploads.secret, { method: 'PUT', key, expires, contentType: input.contentType, maxBytes: input.bytes }),
    expiresAt: new Date(expires * 1000).toISOString(),
    maxBytes: input.bytes,
    contentType: input.contentType,
  };
}

/**
 * A signed-in customer registers a business and becomes its owner. The account is usable at
 * once for prepaid bookings; invoice billing and contract prices need verification and credit.
 */
export async function registerBusiness(deps: BusinessDeps, caller: Caller, raw: unknown): Promise<{ businessId: string }> {
  requireRole(caller, ['customer']);
  const input = parse(registerBusinessSchema, raw);
  for (const key of input.documentKeys) {
    const t = await deps.ops.getUploadTicket(key);
    if (!t || t.driverUid !== caller.uid || !(await deps.evidence.exists(key))) {
      throw new AppError('UPLOAD_NOT_FOUND', 'A document has not finished uploading. Try again.');
    }
  }
  const b: BusinessDoc = {
    id: `biz_${deps.newId()}`,
    ...input,
    ownerUid: caller.uid,
    staffUids: [],
    staffDirectory: {},
    verificationStatus: 'pending',
    verificationNote: null,
    creditTerms: null,
    creditUsedPesewas: 0,
    hasOverdueInvoices: false,
    contractDiscountPercent: 0,
  };
  if ((await deps.biz.createBusiness(b)) === 'owner_has_business') {
    throw new AppError('ALREADY_REGISTERED', 'You already have a business account.');
  }
  const claims = await deps.identity.getClaims(caller.uid);
  await deps.identity.setClaims(caller.uid, { ...claims, role: 'business_owner', businessId: b.id });
  return { businessId: b.id };
}

// ---- Administration -----------------------------------------------------------------------------

export async function reviewBusiness(deps: BusinessDeps, caller: Caller, raw: unknown) {
  requireRole(caller, REVIEW_ROLES);
  const input = parse(reviewBusinessSchema, raw);
  const b = await deps.biz.getBusiness(input.businessId);
  if (!b) throw new AppError('NOT_FOUND', 'Business not found.', 'not-found');
  await deps.biz.updateBusiness(
    b.id,
    {
      verificationStatus: input.decision,
      verificationNote: input.note ?? null,
      // Suspending or rejecting withdraws credit; outstanding invoices remain payable.
      ...(input.decision !== 'verified' ? { creditTerms: null } : {}),
    },
    { actorUid: caller.uid, actorRole: caller.role, action: `business.${input.decision}`, targetType: 'business', targetId: b.id, before: { status: b.verificationStatus }, after: { note: input.note ?? null } },
  );
  return { businessId: b.id, verificationStatus: input.decision };
}

export async function setCreditTerms(deps: BusinessDeps, caller: Caller, raw: unknown) {
  requireRole(caller, CREDIT_ROLES);
  const input = parse(creditTermsSchema, raw);
  const b = await deps.biz.getBusiness(input.businessId);
  if (!b) throw new AppError('NOT_FOUND', 'Business not found.', 'not-found');
  if (b.verificationStatus !== 'verified' && input.limitPesewas > 0) {
    throw new AppError('BUSINESS_NOT_VERIFIED', 'Verify the business before approving credit.');
  }
  const terms = input.limitPesewas > 0 ? { limitPesewas: input.limitPesewas, termDays: input.termDays, approvedBy: caller.uid, approvedAt: deps.now().toISOString() } : null;
  await deps.biz.updateBusiness(b.id, { creditTerms: terms }, { actorUid: caller.uid, actorRole: caller.role, action: 'business.credit_terms', targetType: 'business', targetId: b.id, before: b.creditTerms, after: terms });
  return { businessId: b.id, creditTerms: terms };
}

export async function setContractPricing(deps: BusinessDeps, caller: Caller, raw: unknown) {
  requireRole(caller, CREDIT_ROLES);
  const input = parse(contractPricingSchema, raw);
  const b = await deps.biz.getBusiness(input.businessId);
  if (!b || b.verificationStatus !== 'verified') throw new AppError('BUSINESS_NOT_VERIFIED', 'Contract prices are for verified businesses.');
  await deps.biz.setContract({ businessId: b.id, discountPercent: input.discountPercent, validFrom: new Date(input.validFrom), validTo: new Date(input.validTo), approvedBy: caller.uid });
  await deps.biz.updateBusiness(b.id, { contractDiscountPercent: input.discountPercent }, { actorUid: caller.uid, actorRole: caller.role, action: 'business.contract_pricing', targetType: 'business', targetId: b.id, after: input });
  return { businessId: b.id };
}

// ---- Staff ----------------------------------------------------------------------------------------

export async function inviteStaff(deps: BusinessDeps, caller: Caller, raw: unknown): Promise<{ uid: string; setupLink: string }> {
  const b = await callerBusiness(deps, caller, ['business_owner']);
  if (b.verificationStatus === 'rejected' || b.verificationStatus === 'suspended') throw new AppError('BUSINESS_NOT_VERIFIED', 'This business account is not active.');
  if (b.staffUids.length >= BULK.maxStaff) throw new AppError('VALIDATION_FAILED', `A business can have up to ${BULK.maxStaff} staff accounts.`);
  const input = parse(inviteStaffSchema, raw);
  const created = await deps.identity.createUserWithSetupLink(input);
  if (created === 'exists') {
    throw new AppError('ACCOUNT_EXISTS', 'That email already has an account. Use a work email that is not yet registered.');
  }
  await deps.identity.setClaims(created.uid, { role: 'business_staff', businessId: b.id });
  await deps.biz.addStaff(b.id, created.uid, { name: input.name, email: input.email });
  return created;
}

export async function removeStaff(deps: BusinessDeps, caller: Caller, raw: unknown) {
  const b = await callerBusiness(deps, caller, ['business_owner']);
  const uid = typeof (raw as { uid?: unknown })?.uid === 'string' ? (raw as { uid: string }).uid : '';
  if (!b.staffUids.includes(uid)) throw new AppError('NOT_FOUND', 'That person is not on your staff list.', 'not-found');
  // Back to a plain customer account; existing bookings stay with the business.
  await deps.identity.setClaims(uid, { role: 'customer' });
  await deps.identity.revokeSessions(uid);
  await deps.biz.removeStaff(b.id, uid);
  return { removed: uid };
}

// ---- Address book (the business's own customers) ------------------------------------------------

export async function saveAddressEntry(deps: BusinessDeps, caller: Caller, raw: unknown): Promise<{ id: string }> {
  const b = await callerBusiness(deps, caller);
  const input = parse(addressBookEntrySchema, raw);
  if (!input.id && (await deps.biz.countAddressEntries(b.id)) >= BULK.maxAddressBook) {
    throw new AppError('VALIDATION_FAILED', `The address book holds up to ${BULK.maxAddressBook} entries.`);
  }
  const entry: AddressBookEntry = { id: input.id ?? `ab_${deps.newId()}`, label: input.label, contact: input.contact, address: input.address };
  await deps.biz.saveAddressEntry(b.id, entry);
  return { id: entry.id };
}

export async function deleteAddressEntry(deps: BusinessDeps, caller: Caller, raw: unknown) {
  const b = await callerBusiness(deps, caller);
  const id = typeof (raw as { id?: unknown })?.id === 'string' ? (raw as { id: string }).id : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new AppError('VALIDATION_FAILED', 'Invalid id.', 'invalid-argument');
  await deps.biz.deleteAddressEntry(b.id, id);
  return { deleted: id };
}
