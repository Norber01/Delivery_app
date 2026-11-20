import type { BackupWorkbook, DispatchActionRequest, FinanceReport, RoutePlanDoc, UploadTicket } from '@courier/shared-types';
import { httpsCallable } from 'firebase/functions';
import { getFirebase } from './firebase';

export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

async function call<I, O>(name: string, data: I, timeout = 20_000): Promise<O> {
  try {
    return (await httpsCallable<I, O>(getFirebase().functions, name, { timeout })(data)).data;
  } catch (e) {
    const err = e as { message?: string; details?: { code?: string; fields?: Record<string, string> } };
    // The SDK may append the HTTP status ("… [400]"); staff should see only the message.
    const text = (err.message ?? 'Request failed').replace(/\s*\[\d{3}\]$/, '');
    if (err.details?.code) throw new ApiError(text, err.details.code, err.details.fields ?? {});
    throw new ApiError('Could not reach the server. Check your connection.', 'UNKNOWN');
  }
}

export const api = {
  dispatch: (req: DispatchActionRequest) => call<DispatchActionRequest, { deliveryId: string; status: string }>('dispatchAction', req),
  getEvidenceUrl: (key: string) => call<{ key: string }, { url: string }>('getEvidenceUrl', { key }),
  createDriverAccount: (req: Record<string, unknown>) => call<typeof req, { uid: string; setupLink: string }>('createDriverAccount', req),
  upsertVehicle: (req: Record<string, unknown>) => call<typeof req, { id: string }>('upsertVehicle', req),
  updateDriver: (req: { uid: string; riderType?: 'pickup' | 'delivery'; status?: 'active' | 'suspended' }) => call<typeof req, { uid: string }>('updateDriver', req),
  exportBackup: (req: { from: string; to: string }) => call<typeof req, BackupWorkbook>('exportBackup', req, 300_000),
  upsertHub: (req: Record<string, unknown>) => call<typeof req, { id: string }>('upsertHub', req),
  upsertRoute: (req: Record<string, unknown>) => call<typeof req, { id: string }>('upsertRoute', req),
  hubScan: (req: { hubId: string; type: 'receive' | 'handover'; trackingNumber: string }) =>
    call<typeof req, { trackingNumber: string; status: string; destination: string }>('hubScan', req),
  createManifest: (req: { routeId: string; vehicleId: string; driverUid: string; scheduledDepartureAt: string }) =>
    call<typeof req, { id: string; number: string }>('createManifest', req),
  addToManifest: (req: { manifestId: string; trackingNumber: string }) => call<typeof req, { parcels: number; totalWeightKg: number }>('addToManifest', req),
  removeFromManifest: (req: { manifestId: string; trackingNumber: string }) => call<typeof req, { parcels: number }>('removeFromManifest', req),
  manifestAction: (req: { manifestId: string; action: 'seal' | 'reopen' | 'depart' | 'arrive' | 'close' }) =>
    call<typeof req, { status: string; missing: string[] }>('manifestAction', req),
  reviewBusiness: (req: { businessId: string; decision: 'verified' | 'rejected' | 'suspended'; note?: string }) => call<typeof req, { verificationStatus: string }>('reviewBusiness', req),
  setCreditTerms: (req: { businessId: string; limitPesewas: number; termDays: number }) => call<typeof req, unknown>('setCreditTerms', req),
  setContractPricing: (req: { businessId: string; discountPercent: number; validFrom: string; validTo: string }) => call<typeof req, unknown>('setContractPricing', req),
  generateInvoices: (req: { period: string; businessId?: string }) =>
    call<typeof req, { invoices: { id: string; number: string; businessId: string; totalPesewas: number }[] }>('generateInvoices', req),
  recordInvoicePayment: (req: { invoiceId: string; amountPesewas: number; method: string; reference: string }) => call<typeof req, { status: string }>('recordInvoicePayment', req),
  voidInvoice: (req: { invoiceId: string; reason: string }) => call<typeof req, { status: string }>('voidInvoice', req),
  setUserRole: (req: { email?: string; uid?: string; role: string; hubIds?: string[] }) => call<typeof req, { ok: boolean }>('setUserRole', req),
  // Phase 6
  planDriverRoute: (driverUid: string) => call<{ driverUid: string }, RoutePlanDoc>('planDriverRoute', { driverUid }),
  setVehicleSchedule: (req: Record<string, unknown>) => call<typeof req, unknown>('setVehicleSchedule', req),
  recordMaintenance: (req: Record<string, unknown>) => call<typeof req, { id: string }>('recordMaintenance', req),
  requestReceiptUpload: (req: { contentType: string; bytes: number }) => call<typeof req, UploadTicket>('requestReceiptUpload', req),
  submitExpense: (req: Record<string, unknown>) => call<typeof req, { id: string }>('submitExpense', req),
  reviewExpense: (req: { expenseId: string; decision: 'approved' | 'rejected'; note?: string }) => call<typeof req, { status: string }>('reviewExpense', req),
  setDriverPayRules: (req: Record<string, unknown>) => call<typeof req, unknown>('setDriverPayRules', req),
  generateDriverPay: (period: string) => call<{ period: string }, { saved: number; skipped: number; final: number }>('generateDriverPay', { period }, 120_000),
  adjustDriverPay: (req: { statementId: string; label: string; amountPesewas: number }) => call<typeof req, unknown>('adjustDriverPay', req),
  approveDriverPay: (statementId: string) => call<{ statementId: string }, unknown>('approveDriverPay', { statementId }),
  markDriverPaid: (req: { statementId: string; method: string; reference: string }) => call<typeof req, unknown>('markDriverPaid', req),
  recordCashRemittance: (req: { driverUid: string; amountPesewas: number; method: string; reference: string }) => call<typeof req, unknown>('recordCashRemittance', req),
  getFinanceReport: (period: string, refresh = false) => call<{ period: string; refresh: boolean }, FinanceReport>('getFinanceReport', { period, refresh }, 120_000),
};
