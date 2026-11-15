import type { DriverActionRequest, DriverActionResponse, DriverShift, UploadTicket } from '@courier/shared-types';
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
  startShift: (vehicleId: string) => call<{ vehicleId: string }, DriverShift>('startShift', { vehicleId }),
  endShift: () => call<Record<string, never>, { ended: boolean }>('endShift', {}),
  requestUpload: (r: { deliveryId: string; contentType: 'image/jpeg'; bytes: number }) => call<typeof r, UploadTicket>('requestUpload', r),
};
