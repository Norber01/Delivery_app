import { STAFF_ROLES, type Role } from '@courier/constants';
import { onIdTokenChanged, signOut as fbSignOut, type User } from 'firebase/auth';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { getFirebase } from './firebase';

interface StaffAuth {
  user: User | null;
  role: Role | null;
  /** This session signed in with a second factor (required by the backend for staff actions). */
  mfa: boolean;
  isStaff: boolean;
  /** Hub operator scope from claims (empty for other roles = all hubs). */
  hubIds: string[];
  loading: boolean;
  signOut: () => Promise<void>;
}

const Ctx = createContext<StaffAuth | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<Omit<StaffAuth, 'signOut'>>({ user: null, role: null, mfa: false, isStaff: false, hubIds: [], loading: true });
  useEffect(
    () =>
      onIdTokenChanged(getFirebase().auth, async (user) => {
        if (!user) return setState({ user: null, role: null, mfa: false, isStaff: false, hubIds: [], loading: false });
        const t = await user.getIdTokenResult();
        const role = (typeof t.claims.role === 'string' ? t.claims.role : null) as Role | null;
        setState({
          user,
          role,
          mfa: Boolean(t.signInSecondFactor),
          isStaff: role !== null && (STAFF_ROLES as readonly string[]).includes(role),
          hubIds: Array.isArray(t.claims.hubIds) ? (t.claims.hubIds as string[]) : [],
          loading: false,
        });
      }),
    [],
  );
  return <Ctx.Provider value={{ ...state, signOut: () => fbSignOut(getFirebase().auth) }}>{children}</Ctx.Provider>;
}

export function useStaffAuth() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useStaffAuth outside provider');
  return v;
}

export const canDispatch = (r: Role | null) => r === 'dispatcher' || r === 'manager' || r === 'admin' || r === 'super_admin';
export const canManageFleet = (r: Role | null) => r === 'fleet_manager' || r === 'manager' || r === 'admin' || r === 'super_admin';
export const canOperateHubs = (r: Role | null) => r === 'hub_operator' || r === 'dispatcher' || r === 'manager' || r === 'admin' || r === 'super_admin';
export const canManageNetwork = (r: Role | null) => r === 'admin' || r === 'super_admin';
export const canManageBusinesses = (r: Role | null) => r === 'finance' || r === 'manager' || r === 'admin' || r === 'super_admin';
export const canReviewBusinesses = (r: Role | null) => r === 'manager' || r === 'admin' || r === 'super_admin';
export const canManageInvoices = canManageBusinesses;
/** Manager and admins: the overview of everything. */
export const canOversee = (r: Role | null) => r === 'manager' || r === 'admin' || r === 'super_admin';
/** Excel backup of the business data. */
export const canBackup = (r: Role | null) => r === 'manager' || r === 'finance' || r === 'admin' || r === 'super_admin';
/** Riders list: fleet staff manage it; dispatch and the manager can see it and switch rider types. */
export const canSeeRiders = (r: Role | null) => canManageFleet(r) || canDispatch(r);
export const canManageExpenses = (r: Role | null) => r === 'finance' || r === 'fleet_manager' || r === 'manager' || r === 'admin' || r === 'super_admin';
