import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router';
import { Layout } from './components/Layout';
import { ErrorPage } from './pages/ErrorPage';
import './index.css';
import { RequireAuth } from './components/RequireAuth';
import { AuthProvider } from './lib/auth';
import { AccountPage } from './pages/AccountPage';
import { BookPage } from './pages/BookPage';
import { PaymentReturnPage } from './pages/PaymentReturnPage';
import { ReceiptPage } from './pages/ReceiptPage';
import { SignInPage } from './pages/SignInPage';
import { TrackPage } from './pages/TrackPage';
import { HomePage } from './pages/HomePage';
import { NotFoundPage } from './pages/NotFoundPage';
import { TermsPage } from './pages/TermsPage';

const router = createBrowserRouter([
  {
    element: <Layout />,
    errorElement: <ErrorPage />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/book', element: <BookPage /> },
      { path: '/terms', element: <TermsPage /> },
      { path: '/track', element: <TrackPage /> },
      { path: '/track/:tn', element: <TrackPage /> },
      { path: '/payment/return', element: <PaymentReturnPage /> },
      { path: '/receipt/:tn', element: <ReceiptPage /> },
      { path: '/signin', element: <SignInPage /> },
      {
        path: '/account',
        element: (
          <RequireAuth>
            <AccountPage />
          </RequireAuth>
        ),
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
