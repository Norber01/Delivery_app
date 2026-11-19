import { onIdTokenChanged, signOut as fbSignOut, type User } from 'firebase/auth';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import { getFirebase } from './firebase';

interface AuthState {
  user: User | null;
  role: string | null;
  /** Business accounts: the business this user belongs to. */
  businessId: string | null;
  loading: boolean;
  /** Re-read claims after a server-side role change (e.g. business registration). */
  refreshClaims: () => Promise<void>;
  /** Ensure the account has a role (customer for new sign-ups) and refresh claims. */
  finishSignUp: (displayName?: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [businessId, setBusinessId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { auth } = getFirebase();
    return onIdTokenChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        const token = await u.getIdTokenResult();
        setRole(typeof token.claims.role === 'string' ? token.claims.role : null);
        setBusinessId(typeof token.claims.businessId === 'string' ? token.claims.businessId : null);
      } else {
        setRole(null);
      }
      setLoading(false);
    });
  }, []);

  const finishSignUp = async (displayName?: string) => {
    const { auth } = getFirebase();
    const res = await api.completeSignUp(displayName ? { displayName } : {});
    if (res.claimsUpdated) await auth.currentUser?.getIdToken(true);
    setRole(res.role);
  };

  const signOut = () => fbSignOut(getFirebase().auth);

  const refreshClaims = async () => {
    const u = getFirebase().auth.currentUser;
    if (!u) return;
    const t = await u.getIdTokenResult(true);
    setRole(typeof t.claims.role === 'string' ? t.claims.role : null);
    setBusinessId(typeof t.claims.businessId === 'string' ? t.claims.businessId : null);
  };

  return <Ctx.Provider value={{ user, role, businessId, loading, finishSignUp, signOut, refreshClaims }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}
