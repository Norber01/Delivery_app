import { formatGhs } from '@courier/shared-utils';
import { useState } from 'react';
import { Link, Navigate } from 'react-router';
import { useAuth } from '../../lib/auth';
import { canBookOnAccount, useBusiness } from '../../lib/useBusiness';
import { AddressBook } from './AddressBook';
import { BulkUpload } from './BulkUpload';
import { BusinessBookings } from './BusinessBookings';
import { Invoices } from './Invoices';
import { Reports } from './Reports';
import { Staff } from './Staff';

type Tab = 'overview' | 'bulk' | 'bookings' | 'addresses' | 'staff' | 'invoices' | 'reports';

const STATUS_TEXT = {
  pending: ['Verification in progress', 'You can book and pay per delivery now. Invoice billing and contract prices start once we have verified your documents.'],
  verified: ['Verified business', ''],
  rejected: ['Verification not approved', ''],
  suspended: ['Account suspended', 'Contact our business team.'],
} as const;

export function BusinessPage() {
  const { role, loading: authLoading } = useAuth();
  const { business, loading } = useBusiness();
  const [tab, setTab] = useState<Tab>('overview');
  if (authLoading || loading) return <p className="px-4 py-16 text-center text-slate-500">Loading…</p>;
  if (role === 'customer') return <Navigate to="/business/register" replace />;
  if (!business) return <p className="px-4 py-16 text-center text-slate-600">No business account found for this sign-in.</p>;
  const owner = role === 'business_owner';
  const tabs: [Tab, string][] = [
    ['overview', 'Overview'],
    ['bulk', 'Bulk upload'],
    ['bookings', 'Bookings'],
    ['addresses', 'Address book'],
    ...(owner ? ([['staff', 'Staff'], ['invoices', 'Invoices']] as [Tab, string][]) : []),
    ['reports', 'Reports'],
  ];
  const [title, note] = STATUS_TEXT[business.verificationStatus];
  const credit = business.creditTerms;
  const pct = credit ? Math.min(100, Math.round((business.creditUsedPesewas / credit.limitPesewas) * 100)) : 0;

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{business.tradingName}</h1>
          <p className="text-sm text-slate-500">{business.legalName} · TIN {business.tin}</p>
        </div>
        <Link to="/book" className="btn-primary">
          Book one delivery
        </Link>
      </div>
      <nav className="flex flex-wrap gap-1 border-b border-slate-200" aria-label="Business sections">
        {tabs.map(([id, label]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${tab === id ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900'}`}
            aria-current={tab === id ? 'page' : undefined}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <div className="grid gap-4 md:grid-cols-3">
          <section className="card">
            <p className="text-sm text-slate-500">Account</p>
            <p className={`text-lg font-semibold ${business.verificationStatus === 'verified' ? 'text-brand-700' : business.verificationStatus === 'pending' ? 'text-amber-700' : 'text-red-700'}`}>{title}</p>
            <p className="text-sm text-slate-600">{business.verificationNote ?? note}</p>
          </section>
          <section className="card">
            <p className="text-sm text-slate-500">Invoice billing</p>
            {credit ? (
              <>
                <p className="text-lg font-semibold">
                  {formatGhs(business.creditUsedPesewas)} of {formatGhs(credit.limitPesewas)} used
                </p>
                <div className="mt-2 h-2 rounded bg-slate-100" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Credit used">
                  <div className={`h-2 rounded ${pct > 85 ? 'bg-red-500' : 'bg-brand-600'}`} style={{ width: `${pct}%` }} />
                </div>
                <p className="mt-1 text-sm text-slate-600">Invoices due {credit.termDays} days after issue.</p>
                {business.hasOverdueInvoices && <p className="mt-1 text-sm font-medium text-red-700">An invoice is overdue — account billing is paused.</p>}
              </>
            ) : (
              <p className="text-sm text-slate-600">Not set up. Verified businesses can apply for monthly invoicing on credit.</p>
            )}
          </section>
          <section className="card">
            <p className="text-sm text-slate-500">Your prices</p>
            <p className="text-lg font-semibold">{business.contractDiscountPercent ? `${business.contractDiscountPercent}% contract discount` : 'Standard prices'}</p>
            <p className="text-sm text-slate-600">Bulk uploads get volume discounts automatically.{canBookOnAccount(business) ? ' You can book on account.' : ''}</p>
          </section>
        </div>
      )}
      {tab === 'bulk' && <BulkUpload business={business} />}
      {tab === 'bookings' && <BusinessBookings businessId={business.id} />}
      {tab === 'addresses' && <AddressBook businessId={business.id} />}
      {tab === 'staff' && owner && <Staff business={business} />}
      {tab === 'invoices' && owner && <Invoices businessId={business.id} />}
      {tab === 'reports' && <Reports />}
    </div>
  );
}
