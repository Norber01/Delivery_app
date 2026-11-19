import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { Layout } from './components/Layout';
import { ErrorPage } from './pages/ErrorPage';
import './index.css';
import { RequireAuth } from './components/RequireAuth';
import { AuthProvider } from './lib/auth';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';

/** Route-level code splitting: the home page loads without booking, tracking or account code. */
const page = (load: () => Promise<{ default: React.ComponentType }>) => async () => ({ Component: (await load()).default });
const lazyPage = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  page(async () => ({ default: (await load())[name] }));

/** Lazy page that requires a signed-in account. */
const authed = <K extends string>(load: () => Promise<Record<K, React.ComponentType>>, name: K) =>
  page(async () => {
    const C: React.ComponentType = (await load())[name];
    return {
      default: () => (
        <RequireAuth>
          <C />
        </RequireAuth>
      ),
    };
  });

const router = createBrowserRouter([
  {
    element: <Layout />,
    errorElement: <ErrorPage />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/book', lazy: lazyPage(() => import('./pages/BookPage'), 'BookPage') },
      { path: '/terms', lazy: lazyPage(() => import('./pages/TermsPage'), 'TermsPage') },
      { path: '/track', lazy: lazyPage(() => import('./pages/TrackPage'), 'TrackPage') },
      { path: '/track/:tn', lazy: lazyPage(() => import('./pages/TrackPage'), 'TrackPage') },
      { path: '/payment/return', lazy: lazyPage(() => import('./pages/PaymentReturnPage'), 'PaymentReturnPage') },
      { path: '/receipt/:tn', lazy: lazyPage(() => import('./pages/ReceiptPage'), 'ReceiptPage') },
      { path: '/label/:tn', lazy: lazyPage(() => import('./pages/LabelPage'), 'LabelPage') },
      { path: '/signin', lazy: lazyPage(() => import('./pages/SignInPage'), 'SignInPage') },
      { path: '/business', lazy: authed(() => import('./pages/business/BusinessPage'), 'BusinessPage') },
      { path: '/business/register', lazy: authed(() => import('./pages/BusinessRegisterPage'), 'BusinessRegisterPage') },
      { path: '/business/labels', lazy: authed(() => import('./pages/business/BulkLabelsPage'), 'BulkLabelsPage') },
      { path: '/business/invoices/:id', lazy: authed(() => import('./pages/business/InvoicePage'), 'InvoicePage') },
      {
        path: '/account',
        lazy: page(async () => {
          const { AccountPage } = await import('./pages/AccountPage');
          return {
            default: () => (
              <RequireAuth>
                <AccountPage />
              </RequireAuth>
            ),
          };
        }),
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
], { basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/' });

// Demo build: start the in-browser backend straight away (shows the demo bar on every page).
if (import.meta.env.VITE_DEMO === 'true') void import('@courier/demo-backend').then((m) => m.demoReady());

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
