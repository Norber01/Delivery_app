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
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  </StrictMode>,
);
