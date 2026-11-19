import type { DriverActionRequest, DriverActionResponse, DriverShift, RoutePlanDoc, UploadTicket } from '@courier/shared-types';
import { httpsCallable } from 'firebase/functions';
import { toActionError } from '../core/queue';
import { functions } from './firebase';

async function call<I, O>(name: string, data: I): Promise<O> {
  try {
    return (await httpsCallable<I, O>(functions, name, { timeout: 20_000 })(data)).data;
  } catch (e) {
    throw toActionError(e);
  }
}

export const api = {
  driverAction: (r: DriverActionRequest) => call<DriverActionRequest, DriverActionResponse>('driverAction', r),
  startShift: (vehicleId: string, odometerKm?: number) => call<{ vehicleId: string; odometerKm?: number }, DriverShift>('startShift', { vehicleId, ...(odometerKm !== undefined ? { odometerKm } : {}) }),
  endShift: (odometerKm?: number) => call<{ odometerKm?: number }, { ended: boolean }>('endShift', odometerKm !== undefined ? { odometerKm } : {}),
  planMyRoute: () => call<Record<string, never>, RoutePlanDoc>('planDriverRoute', {}),
  requestReceiptUpload: (r: { contentType: 'image/jpeg'; bytes: number }) => call<typeof r, UploadTicket>('requestReceiptUpload', r),
  logFuel: (r: { litres: number; amountPesewas: number; odometerKm: number; fullTank: boolean; station?: string; receiptKey?: string }) => call<typeof r, { id: string }>('logFuel', r),
  requestUpload: (r: { deliveryId: string; contentType: 'image/jpeg'; bytes: number }) => call<typeof r, UploadTicket>('requestUpload', r),
};
