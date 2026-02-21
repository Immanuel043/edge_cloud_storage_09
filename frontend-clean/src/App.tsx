import React, { Suspense, useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { bootstrapWithVerification } from './utils/bootstrapVerification';
import { StorageProvider } from './contexts/StorageContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { NotificationProvider } from './contexts/NotificationContext';
import { SubscriptionProvider } from './contexts/SubscriptionContext';
import NotificationToast from './components/notifications/NotificationToast';
const AuthPage = React.lazy(() => import('./components/auth/AuthPage'));
const Dashboard = React.lazy(() => import('./components/dashboard/Dashboard'));
const ShareViewer = React.lazy(() => import('./components/share/ShareViewer'));
const ShareBundleViewer = React.lazy(() => import('./components/share/ShareBundleViewer'));
const PricingPage = React.lazy(() => import('./components/pricing/PricingPage'));
import { useAuth } from './contexts/AuthContext';

/**
 * Billing Success Page - shown after successful Stripe redirect
 */
const BillingSuccessPage: React.FC = () => {
  React.useEffect(() => {
    // Redirect to dashboard after 3 seconds
    const timer = setTimeout(() => {
      window.location.href = '/';
    }, 3000);
    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
      <div className="text-center max-w-md mx-auto p-8">
        <div className="w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
          <svg className="w-8 h-8 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Payment Successful!</h1>
        <p className="text-gray-600 dark:text-gray-400 mb-4">
          Your subscription has been activated. Redirecting to dashboard...
        </p>
        <a href="/" className="text-blue-600 hover:text-blue-700 font-medium">
          Go to Dashboard
        </a>
      </div>
    </div>
  );
};

/**
 * Billing Failure Page - shown after failed payment
 */
const BillingFailurePage: React.FC = () => (
  <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
    <div className="text-center max-w-md mx-auto p-8">
      <div className="w-16 h-16 bg-red-100 dark:bg-red-900/30 rounded-full flex items-center justify-center mx-auto mb-4">
        <svg className="w-8 h-8 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
        </svg>
      </div>
      <h1 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">Payment Failed</h1>
      <p className="text-gray-600 dark:text-gray-400 mb-4">
        Something went wrong with your payment. No charges were made.
      </p>
      <div className="space-x-4">
        <a href="/pricing" className="text-blue-600 hover:text-blue-700 font-medium">
          Try Again
        </a>
        <a href="/" className="text-gray-600 hover:text-gray-700 font-medium">
          Go to Dashboard
        </a>
      </div>
    </div>
  </div>
);

/**
 * Props for ProtectedRoute component
 */
interface ProtectedRouteProps {
  children: React.ReactNode;
}

/**
 * ProtectedRoute Component
 *
 * Wraps routes that require authentication.
 * Redirects to /auth if user is not authenticated
 */
const ProtectedRoute: React.FC<ProtectedRouteProps> = ({ children }) => {
  const { isAuthenticated, loading } = useAuth();

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">Loading...</div>
    );
  }

  return isAuthenticated ? <>{children}</> : <Navigate to="/auth" replace />;
};

/**
 * Main App Component
 *
 * Sets up routing, context providers, and application structure.
 */
const App: React.FC = () => {
  // Gate rendering behind bootstrap verification to prevent stale localStorage
  // from causing wrong auth provider selection (e.g., deleted ZK account)
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
              <StorageProvider>
                <SubscriptionProvider>
                  <Suspense fallback={<div>Loading app...</div>}>
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
                            <Dashboard />
                          </ProtectedRoute>
                        }
                      />
                      {/* add more protected or public routes here */}
                      <Route path="*" element={<Navigate to="/" replace />} />
                    </Routes>
                  </Suspense>
                  <NotificationToast />
                </SubscriptionProvider>
              </StorageProvider>
            </AuthProvider>
          ) : (
            <div className="min-h-screen flex items-center justify-center bg-gray-50 dark:bg-gray-900">
              <div className="text-center">
                <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
                <p className="text-gray-500 dark:text-gray-400">Loading...</p>
              </div>
            </div>
          )}
        </NotificationProvider>
      </ThemeProvider>
    </Router>
  );
};

export default App;
