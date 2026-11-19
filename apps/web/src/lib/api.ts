import type {
  BulkConfirmResult,
  BulkPreview,
  BusinessReport,
  UploadTicket,
  BookingAccessRequest,
  CreateBookingResponse,
  InitiatePaymentResponse,
  PaymentStatusResponse,
  QuoteResponse,
  TrackingView,
} from '@courier/shared-types';
import type { CreateBookingInput, QuoteRequestInput } from '@courier/validation';
import { httpsCallable } from 'firebase/functions';
import { toApiError } from './errors';
import { getBackend } from './firebase';

async function call<I, O>(name: string, data: I, timeout = 20_000): Promise<O> {
  try {
    const fn = httpsCallable<I, O>(getBackend(), name, { timeout });
    return (await fn(data)).data;
  } catch (e) {
    throw toApiError(e);
  }
}

export const api = {
  getQuote: (req: QuoteRequestInput) => call<QuoteRequestInput, QuoteResponse>('getQuote', req),
  createBooking: (req: CreateBookingInput) => call<CreateBookingInput, CreateBookingResponse>('createBooking', req),
  getTrackingView: (req: BookingAccessRequest) => call<BookingAccessRequest, TrackingView>('getTrackingView', req),
  initiatePayment: (req: BookingAccessRequest) => call<BookingAccessRequest, InitiatePaymentResponse>('initiatePayment', req),
  getPaymentStatus: (req: BookingAccessRequest) => call<BookingAccessRequest, PaymentStatusResponse>('getPaymentStatus', req),
  completeSignUp: (req: { displayName?: string }) => call<typeof req, { role: string; claimsUpdated: boolean }>('completeSignUp', req),
  claimBooking: (req: BookingAccessRequest) => call<BookingAccessRequest, { trackingNumber: string }>('claimBooking', req),
  requestBusinessDocumentUpload: (req: { contentType: string; bytes: number }) => call<typeof req, UploadTicket>('requestBusinessDocumentUpload', req),
  registerBusiness: (req: Record<string, unknown>) => call<typeof req, { businessId: string }>('registerBusiness', req),
  inviteBusinessStaff: (req: { name: string; email: string }) => call<typeof req, { uid: string; setupLink: string }>('inviteBusinessStaff', req),
  removeBusinessStaff: (req: { uid: string }) => call<typeof req, { removed: string }>('removeBusinessStaff', req),
  saveAddressEntry: (req: Record<string, unknown>) => call<typeof req, { id: string }>('saveAddressEntry', req),
  deleteAddressEntry: (req: { id: string }) => call<typeof req, { deleted: string }>('deleteAddressEntry', req),
  previewBulkBooking: (req: { pickup: unknown; paymentPreference: string; rows: Record<string, string>[] }) => call<typeof req, BulkPreview>('previewBulkBooking', req, 300_000),
  confirmBulkBooking: (req: { batchId: string; acceptTerms: true }) => call<typeof req, BulkConfirmResult>('confirmBulkBooking', req, 300_000),
  getBusinessReport: (req: { month: string }) => call<typeof req, BusinessReport>('getBusinessReport', req),
};
