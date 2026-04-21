import React, { Suspense, useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { bootstrapWithVerification } from './utils/bootstrapVerification';
import { StorageProvider } from './contexts/StorageContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { NotificationProvider } from './contexts/NotificationContext';
import { SubscriptionProvider } from './contexts/SubscriptionContext';
import NotificationToast from './components/notifications/NotificationToast';
import OfflineBanner from './components/common/OfflineBanner';
import { Spinner, Toaster } from '@/components/ui';

const AuthPage = React.lazy(() => import('./components/auth/AuthPage'));
const Dashboard = React.lazy(() => import('./components/dashboard/Dashboard'));
const ShareViewer = React.lazy(() => import('./components/share/ShareViewer'));
const ShareBundleViewer = React.lazy(() => import('./components/share/ShareBundleViewer'));
const PricingPage = React.lazy(() => import('./components/pricing/PricingPage'));
const BillingSuccessPage = React.lazy(() =>
  import('./components/billing/BillingResult').then((m) => ({ default: m.BillingSuccessPage }))
);
const BillingFailurePage = React.lazy(() =>
  import('./components/billing/BillingResult').then((m) => ({ default: m.BillingFailurePage }))
);

/**
 * Loader shown while lazy-loaded route chunks or bootstrap verification are
 * in-flight. Centered spinner over the app background.
 */
const FullScreenLoader: React.FC = () => (
  <div className="flex min-h-screen items-center justify-center bg-bg">
    <div className="text-center">
      <Spinner size="lg" />
      <p className="mt-4 text-body-sm text-fg-muted">Loading...</p>
    </div>
  </div>
);

interface ProtectedRouteProps {
  children: React.ReactNode;
}

/**
 * ProtectedRoute — redirects to /auth if the user is not authenticated.
 */
const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { isAuthenticated, loading } = useAuth();

  if (loading) return <FullScreenLoader />;

  return isAuthenticated ? <>{children}</> : <Navigate to="/auth" replace />;
};

/**
 * App — top-level providers + router. Bootstrap verification gates
 * AuthProvider mounting to avoid stale localStorage causing wrong auth
 * provider selection (e.g., a deleted ZK account).
 */
const App: React.FC = () => {
  const [bootstrapped, setBootstrapped] = useState(false);

  useEffect(() => {
    bootstrapWithVerification().then(() => setBootstrapped(true));
  }, []);

  return (
    <Router>
      <ThemeProvider>
        <NotificationProvider>
          {bootstrapped ? (
            <AuthProvider>
              <SubscriptionProvider>
                <Suspense fallback={<FullScreenLoader />}>
                  <Routes>
                    <Route path="/auth" element={<AuthPage />} />
                    <Route path="/pricing" element={<PricingPage />} />
                    <Route path="/share/:token" element={<ShareViewer />} />
                    <Route path="/share/bundle/:token" element={<ShareBundleViewer />} />
                    <Route path="/billing/success" element={<BillingSuccessPage />} />
                    <Route path="/billing/failure" element={<BillingFailurePage />} />
                    <Route
                      path="/"
                      element={
                        <ProtectedRoute>
                          <StorageProvider>
                            <OfflineBanner />
                            <Dashboard />
                          </StorageProvider>
                        </ProtectedRoute>
                      }
                    />
                    <Route path="*" element={<Navigate to="/" replace />} />
                  </Routes>
                </Suspense>
                <NotificationToast />
                <Toaster />
              </SubscriptionProvider>
            </AuthProvider>
          ) : (
            <FullScreenLoader />
          )}
        </NotificationProvider>
      </ThemeProvider>
    </Router>
  );
};

export default App;
