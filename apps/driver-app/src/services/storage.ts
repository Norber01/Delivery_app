import AsyncStorage from '@react-native-async-storage/async-storage';
import type { DriverShift } from '@courier/shared-types';
import type { KeyValueStorage } from '../core/queue';

export const storage: KeyValueStorage = {
  getItem: (k) => AsyncStorage.getItem(k),
  setItem: (k, v) => AsyncStorage.setItem(k, v),
};

const SHIFT_KEY = 'current-shift:v1';

/** The active shift is persisted so the headless location task can read it. */
export const shiftStore = {
  async get(): Promise<DriverShift | null> {
    const raw = await AsyncStorage.getItem(SHIFT_KEY);
    return raw ? (JSON.parse(raw) as DriverShift) : null;
  },
  set: (s: DriverShift) => AsyncStorage.setItem(SHIFT_KEY, JSON.stringify(s)),
  clear: () => AsyncStorage.removeItem(SHIFT_KEY),
};
