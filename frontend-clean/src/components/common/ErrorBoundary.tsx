import React from 'react';
import type { ErrorBoundaryProps, ErrorBoundaryState } from './types';
import { hasErrorLogger } from './types';

/**
 * ErrorBoundary Component
 *
 * Catches React component errors and displays fallback UI.
 * Implements React error boundary pattern with proper TypeScript typing.
 *
 * Features:
 * - Catches errors in child component tree
 * - Displays user-friendly error message
 * - Shows detailed error info in development mode
 * - Tracks error count and auto-reloads after multiple errors
 * - Integrates with error logging services (if available)
 */
class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
      errorCount: 0,
    };
  }

  /**
   * Update state when an error is caught
   * React guarantees error is an Error instance
   */
  static getDerivedStateFromError(_error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true };
  }

  /**
   * Log error details and update state
   * React guarantees both parameters are properly typed
   */
  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Log error to console
    console.error('ErrorBoundary caught error:', error, errorInfo);

    // Update state
    this.setState((prevState) => ({
      error,
      errorInfo,
      errorCount: prevState.errorCount + 1,
    }));

    // Send error to monitoring service (e.g., Sentry) if available
    if (hasErrorLogger(window)) {
      window.errorLogger.logError(error, errorInfo);
    }
  }

  /**
   * Reset error state and optionally reload page
   */
  handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });

    // Reload page if too many errors
    if (this.state.errorCount >= 3) {
      window.location.reload();
    }
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: '400px',
            padding: '2rem',
            textAlign: 'center',
          }}
        >
          <div
            style={{
              fontSize: '4rem',
              marginBottom: '1rem',
            }}
          >
            ⚠️
          </div>

          <h1
            style={{
              fontSize: '1.5rem',
              marginBottom: '0.5rem',
              color: '#ef4444',
            }}
          >
            Something went wrong
          </h1>

          <p
            style={{
              color: '#6b7280',
              marginBottom: '1.5rem',
              maxWidth: '500px',
            }}
          >
            {this.props.fallbackMessage ||
              "We're sorry, but something unexpected happened. Please try refreshing the page."}
          </p>

          {process.env.NODE_ENV === 'development' && this.state.error && (
            <details
              style={{
                marginBottom: '1.5rem',
                padding: '1rem',
                backgroundColor: '#fee2e2',
                borderRadius: '0.5rem',
                maxWidth: '600px',
                textAlign: 'left',
                overflow: 'auto',
              }}
            >
              <summary
                style={{
                  cursor: 'pointer',
                  fontWeight: 'bold',
                  marginBottom: '0.5rem',
                }}
              >
                Error Details (Development Only)
              </summary>
              <pre
                style={{
                  fontSize: '0.875rem',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                }}
              >
                {this.state.error.toString()}
                {'\n\n'}
                {this.state.errorInfo?.componentStack}
              </pre>
            </details>
          )}

          <div style={{ display: 'flex', gap: '1rem' }}>
            <button
              onClick={this.handleReset}
              style={{
                padding: '0.75rem 1.5rem',
                backgroundColor: '#3b82f6',
                color: 'white',
                border: 'none',
                borderRadius: '0.5rem',
                cursor: 'pointer',
                fontSize: '1rem',
                fontWeight: '500',
              }}
            >
              Try Again
            </button>

            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '0.75rem 1.5rem',
                backgroundColor: '#6b7280',
                color: 'white',
                border: 'none',
                borderRadius: '0.5rem',
                cursor: 'pointer',
                fontSize: '1rem',
                fontWeight: '500',
              }}
            >
              Reload Page
            </button>
          </div>

          {this.state.errorCount >= 2 && (
            <p
              style={{
                marginTop: '1rem',
                fontSize: '0.875rem',
                color: '#dc2626',
              }}
            >
              Multiple errors detected. Next error will trigger automatic reload.
            </p>
          )}
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
