import type { SavedAddress } from '@courier/validation';
import { doc, onSnapshot } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { useAuth } from './auth';
import { getDb } from './db';

export function useSavedAddresses(): SavedAddress[] {
  const { user, role } = useAuth();
  const [saved, setSaved] = useState<SavedAddress[]>([]);
  useEffect(() => {
    if (!user || role !== 'customer') return setSaved([]);
    return onSnapshot(
      doc(getDb(), 'customers', user.uid),
      (snap) => setSaved((snap.get('savedAddresses') as SavedAddress[] | undefined) ?? []),
      () => setSaved([]),
    );
  }, [user, role]);
  return saved;
}
