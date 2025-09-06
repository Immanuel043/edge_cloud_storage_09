import React from 'react';
import AuthPage from './components/auth/AuthPage';
import Dashboard from './components/dashboard/Dashboard';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { StorageProvider } from './contexts/StorageContext';

function AppContent() {
  const { isAuthenticated } = useAuth();
  return isAuthenticated ? <Dashboard /> : <AuthPage />;
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <StorageProvider>
          <AppContent />
        </StorageProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}