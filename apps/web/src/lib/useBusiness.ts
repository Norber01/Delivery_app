import type { BusinessDoc } from '@courier/shared-types';
import { doc, onSnapshot } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { useAuth } from './auth';
import { getDb } from './db';

/** The signed-in user's business (owner or staff), live; null when not a business member. */
export function useBusiness(): { business: BusinessDoc | null; loading: boolean } {
  const { businessId, role } = useAuth();
  const [business, setBusiness] = useState<BusinessDoc | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!businessId || (role !== 'business_owner' && role !== 'business_staff')) {
      setBusiness(null);
      setLoading(false);
      return;
    }
    return onSnapshot(
      doc(getDb(), 'sellers', businessId),
      (s) => {
        setBusiness(s.exists() ? (s.data() as BusinessDoc) : null);
        setLoading(false);
      },
      () => setLoading(false),
    );
  }, [businessId, role]);
  return { business, loading };
}

/** Invoice billing is open when verified, credit approved, nothing overdue and credit left. */
export function canBookOnAccount(b: BusinessDoc | null): boolean {
  return Boolean(b && b.verificationStatus === 'verified' && b.creditTerms && !b.hasOverdueInvoices && b.creditUsedPesewas < b.creditTerms.limitPesewas);
}
