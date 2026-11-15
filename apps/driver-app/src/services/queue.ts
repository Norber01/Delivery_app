import { ActionQueue } from '../core/queue';
import { api } from './api';
import { storage } from './storage';
import { uploadPhoto } from './uploads';

/** Single app-wide queue of driver actions. */
export const actionQueue = new ActionQueue({ storage, send: api.driverAction, uploadPhoto, now: () => new Date() });

/** Retry pending actions every 30 s while the app is open. */
setInterval(() => void actionQueue.process(), 30_000);
