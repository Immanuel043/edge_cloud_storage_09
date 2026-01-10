# Subscription UI Components

React components and API integration for subscription management.

---

## API Endpoints Created

### 1. Dashboard (Single Request)
```
GET /api/v1/subscription-ui/dashboard
```
Returns complete subscription dashboard in one request:
- Current subscription status with usage
- All available plans formatted for cards
- Usage warnings
- Upgrade recommendations

### 2. Plan Comparison
```
GET /api/v1/subscription-ui/plans/compare?plan_codes=normal_free,normal_basic,normal_pro
```
Compare multiple plans side-by-side

### 3. Usage Summary
```
GET /api/v1/subscription-ui/usage/summary
```
Get usage optimized for progress bars and charts

---

## React Components

### 1. SubscriptionDashboard.jsx

```jsx
import React, { useState, useEffect } from 'react';
import axios from 'axios';

export function SubscriptionDashboard({ apiBaseUrl, authToken }) {
  const [dashboard, setDashboard] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchDashboard();
  }, []);

  const fetchDashboard = async () => {
    try {
      setLoading(true);
      const response = await axios.get(
        `${apiBaseUrl}/api/v1/subscription-ui/dashboard`,
        { headers: { Authorization: `Bearer ${authToken}` } }
      );
      setDashboard(response.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.detail || 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <LoadingSpinner />;
  if (error) return <ErrorAlert message={error} />;
  if (!dashboard) return null;

  return (
    <div className="subscription-dashboard">
      {/* Current Subscription Card */}
      <CurrentSubscriptionCard subscription={dashboard.current_subscription} />

      {/* Usage Warnings */}
      {dashboard.usage_warnings.length > 0 && (
        <UsageWarnings warnings={dashboard.usage_warnings} />
      )}

      {/* Available Plans Grid */}
      <div className="plans-grid">
        {dashboard.available_plans.map(plan => (
          <PlanCard
            key={plan.plan_code}
            plan={plan}
            onSelectPlan={handleSelectPlan}
          />
        ))}
      </div>

      {/* Recommendations */}
      {dashboard.recommendations.length > 0 && (
        <Recommendations recommendations={dashboard.recommendations} />
      )}
    </div>
  );
}
```

### 2. PlanCard.jsx

```jsx
export function PlanCard({ plan, onSelectPlan }) {
  const {
    display_name,
    price_display,
    storage_gb,
    bandwidth_mbps,
    features,
    is_current,
    is_upgrade,
    is_downgrade,
    badge,
    highlight
  } = plan;

  const getButtonText = () => {
    if (is_current) return 'Current Plan';
    if (is_upgrade) return 'Upgrade';
    if (is_downgrade) return 'Downgrade';
    return 'Select Plan';
  };

  const getButtonVariant = () => {
    if (is_current) return 'secondary';
    if (is_upgrade) return 'primary';
    if (is_downgrade) return 'outline';
    return 'primary';
  };

  return (
    <div className={`plan-card ${highlight ? 'plan-card--highlight' : ''} ${is_current ? 'plan-card--current' : ''}`}>
      {badge && <div className="plan-card__badge">{badge}</div>}

      <div className="plan-card__header">
        <h3 className="plan-card__title">{display_name}</h3>
        <div className="plan-card__price">{price_display}</div>
      </div>

      <div className="plan-card__specs">
        <div className="spec-item">
          <svg className="spec-icon">
            <use xlinkHref="#icon-storage" />
          </svg>
          <span>{storage_gb} GB Storage</span>
        </div>
        <div className="spec-item">
          <svg className="spec-icon">
            <use xlinkHref="#icon-speed" />
          </svg>
          <span>{bandwidth_mbps} Mbps Speed</span>
        </div>
      </div>

      <ul className="plan-card__features">
        {features.map((feature, idx) => (
          <li key={idx} className={`feature ${feature.available ? '' : 'feature--unavailable'}`}>
            <svg className="feature__icon">
              <use xlinkHref={feature.available ? '#icon-check' : '#icon-cross'} />
            </svg>
            <span>{feature.description}</span>
            {feature.tooltip && (
              <span className="feature__tooltip" title={feature.tooltip}>
                <svg><use xlinkHref="#icon-info" /></svg>
              </span>
            )}
          </li>
        ))}
      </ul>

      <button
        className={`plan-card__button btn btn--${getButtonVariant()}`}
        onClick={() => onSelectPlan(plan.plan_code)}
        disabled={is_current}
      >
        {getButtonText()}
      </button>
    </div>
  );
}
```

### 3. UsageProgressBar.jsx

```jsx
export function UsageProgressBar({ apiBaseUrl, authToken }) {
  const [usage, setUsage] = useState(null);

  useEffect(() => {
    fetchUsage();
    const interval = setInterval(fetchUsage, 30000); // Refresh every 30s
    return () => clearInterval(interval);
  }, []);

  const fetchUsage = async () => {
    try {
      const response = await axios.get(
        `${apiBaseUrl}/api/v1/subscription-ui/usage/summary`,
        { headers: { Authorization: `Bearer ${authToken}` } }
      );
      setUsage(response.data);
    } catch (err) {
      console.error('Failed to fetch usage:', err);
    }
  };

  if (!usage) return null;

  const { storage } = usage;
  const progressBarClass = `progress-bar progress-bar--${storage.color}`;

  return (
    <div className="usage-widget">
      <div className="usage-widget__header">
        <span className="usage-widget__label">Storage</span>
        <span className="usage-widget__value">{storage.display}</span>
      </div>
      <div className="progress">
        <div
          className={progressBarClass}
          style={{ width: `${storage.percent}%` }}
          role="progressbar"
          aria-valuenow={storage.percent}
          aria-valuemin="0"
          aria-valuemax="100"
        >
          {storage.percent}%
        </div>
      </div>
      {storage.percent > 80 && (
        <div className="usage-widget__warning">
          ⚠️ You're running low on storage. Consider upgrading your plan.
        </div>
      )}
    </div>
  );
}
```

### 4. PlanComparisonTable.jsx

```jsx
export function PlanComparisonTable({ planCodes, apiBaseUrl, authToken }) {
  const [comparison, setComparison] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchComparison();
  }, [planCodes]);

  const fetchComparison = async () => {
    try {
      const response = await axios.get(
        `${apiBaseUrl}/api/v1/subscription-ui/plans/compare?plan_codes=${planCodes.join(',')}`,
        { headers: { Authorization: `Bearer ${authToken}` } }
      );
      setComparison(response.data);
    } catch (err) {
      console.error('Failed to fetch comparison:', err);
    } finally {
      setLoading(false);
    }
  };

  if (loading) return <LoadingSpinner />;
  if (!comparison) return null;

  return (
    <div className="plan-comparison">
      <table className="comparison-table">
        <thead>
          <tr>
            <th>Feature</th>
            {comparison.plans.map(plan => (
              <th key={plan.plan_code}>
                <div className="plan-header">
                  <div className="plan-name">{plan.display_name}</div>
                  <div className="plan-price">
                    {plan.price_monthly ? `$${plan.price_monthly}/mo` : 'Free'}
                  </div>
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {Object.entries(comparison.features).map(([feature, values]) => (
            <tr key={feature}>
              <td className="feature-name">{feature}</td>
              {values.map((value, idx) => (
                <td key={idx}>
                  {typeof value === 'boolean' ? (
                    value ? '✓' : '✗'
                  ) : (
                    value
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
```

### 5. UpgradeModal.jsx

```jsx
export function UpgradeModal({ isOpen, onClose, targetPlan, currentPlan, onConfirm }) {
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState(null);

  useEffect(() => {
    if (isOpen && targetPlan) {
      fetchPreview();
    }
  }, [isOpen, targetPlan]);

  const fetchPreview = async () => {
    try {
      const response = await axios.post(
        `${apiBaseUrl}/api/v1/billing/preview-change`,
        { new_plan_code: targetPlan.plan_code },
        { headers: { Authorization: `Bearer ${authToken}` } }
      );
      setPreview(response.data);
    } catch (err) {
      console.error('Failed to fetch preview:', err);
    }
  };

  const handleConfirm = async () => {
    setLoading(true);
    try {
      await onConfirm(targetPlan.plan_code);
      onClose();
    } catch (err) {
      console.error('Upgrade failed:', err);
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Upgrade to {targetPlan?.display_name}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div className="modal-body">
          {preview && (
            <>
              <div className="upgrade-summary">
                <div className="summary-row">
                  <span>Current Plan:</span>
                  <strong>{preview.current_plan.display_name}</strong>
                </div>
                <div className="summary-row">
                  <span>New Plan:</span>
                  <strong>{preview.new_plan.display_name}</strong>
                </div>
                <div className="summary-row summary-row--highlight">
                  <span>Additional Storage:</span>
                  <strong>+{preview.storage_change_gb} GB</strong>
                </div>
                <div className="summary-row summary-row--highlight">
                  <span>New Speed:</span>
                  <strong>{preview.new_bandwidth_mbps} Mbps</strong>
                </div>
              </div>

              <div className="pricing-info">
                <p>Your new monthly price will be <strong>${targetPlan.price_monthly}/mo</strong></p>
                <p className="pricing-note">Changes take effect immediately</p>
              </div>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn btn--secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn--primary"
            onClick={handleConfirm}
            disabled={loading}
          >
            {loading ? 'Processing...' : 'Confirm Upgrade'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

---

## CSS Styles

### Subscription Dashboard Styles

```css
.subscription-dashboard {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem;
}

.plans-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 2rem;
  margin: 2rem 0;
}

.plan-card {
  border: 2px solid #e0e0e0;
  border-radius: 12px;
  padding: 2rem;
  position: relative;
  transition: transform 0.2s, box-shadow 0.2s;
  background: white;
}

.plan-card:hover {
  transform: translateY(-4px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.1);
}

.plan-card--highlight {
  border-color: #4CAF50;
  box-shadow: 0 4px 12px rgba(76, 175, 80, 0.2);
}

.plan-card--current {
  background: #f5f5f5;
  border-color: #2196F3;
}

.plan-card__badge {
  position: absolute;
  top: -12px;
  right: 20px;
  background: #FF9800;
  color: white;
  padding: 0.25rem 0.75rem;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 600;
}

.plan-card__header {
  margin-bottom: 1.5rem;
  text-align: center;
}

.plan-card__title {
  font-size: 1.5rem;
  font-weight: 700;
  margin-bottom: 0.5rem;
  color: #333;
}

.plan-card__price {
  font-size: 2rem;
  font-weight: 700;
  color: #4CAF50;
}

.plan-card__specs {
  margin-bottom: 1.5rem;
  padding-bottom: 1.5rem;
  border-bottom: 1px solid #e0e0e0;
}

.spec-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  color: #666;
}

.spec-icon {
  width: 20px;
  height: 20px;
  fill: #4CAF50;
}

.plan-card__features {
  list-style: none;
  padding: 0;
  margin: 0 0 2rem 0;
}

.feature {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  color: #333;
}

.feature--unavailable {
  color: #999;
  text-decoration: line-through;
}

.feature__icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.feature__tooltip {
  margin-left: auto;
  cursor: help;
}

.plan-card__button {
  width: 100%;
  padding: 0.75rem;
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}

.btn--primary {
  background: #4CAF50;
  color: white;
}

.btn--primary:hover:not(:disabled) {
  background: #45a049;
}

.btn--secondary {
  background: #e0e0e0;
  color: #666;
}

.btn--outline {
  background: white;
  color: #4CAF50;
  border: 2px solid #4CAF50;
}

.usage-widget {
  background: white;
  border-radius: 8px;
  padding: 1.5rem;
  margin-bottom: 2rem;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.usage-widget__header {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.usage-widget__label {
  font-weight: 600;
  color: #666;
}

.usage-widget__value {
  font-weight: 700;
  color: #333;
}

.progress {
  height: 24px;
  background: #f0f0f0;
  border-radius: 12px;
  overflow: hidden;
}

.progress-bar {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.875rem;
  font-weight: 600;
  color: white;
  transition: width 0.3s ease;
}

.progress-bar--success {
  background: #4CAF50;
}

.progress-bar--warning {
  background: #FF9800;
}

.progress-bar--danger {
  background: #F44336;
}

.usage-widget__warning {
  margin-top: 0.75rem;
  padding: 0.75rem;
  background: #FFF3E0;
  border-left: 4px solid #FF9800;
  border-radius: 4px;
  font-size: 0.875rem;
  color: #E65100;
}
```

---

## Integration Example

```jsx
import React from 'react';
import { SubscriptionDashboard, UsageProgressBar } from './components/subscription';

function App() {
  const apiBaseUrl = 'http://localhost:8001';
  const authToken = localStorage.getItem('auth_token');

  return (
    <div className="app">
      <header>
        <h1>My Storage</h1>
        <UsageProgressBar apiBaseUrl={apiBaseUrl} authToken={authToken} />
      </header>

      <main>
        <SubscriptionDashboard apiBaseUrl={apiBaseUrl} authToken={authToken} />
      </main>
    </div>
  );
}
```

---

## Testing

### Test Dashboard API
```bash
curl -H "Authorization: Bearer <token>" \
  http://localhost:8001/api/v1/subscription-ui/dashboard
```

### Test Usage Summary
```bash
curl -H "Authorization: Bearer <token>" \
  http://localhost:8001/api/v1/subscription-ui/usage/summary
```

### Test Plan Comparison
```bash
curl -H "Authorization: Bearer <token>" \
  "http://localhost:8001/api/v1/subscription-ui/plans/compare?plan_codes=normal_free,normal_basic,normal_pro"
```

---

## Features

✅ **Single Request Dashboard** - All data in one API call
✅ **Formatted for UI** - Pre-calculated percentages, colors, badges
✅ **Real-time Usage** - Live storage and bandwidth monitoring
✅ **Plan Comparison** - Side-by-side feature comparison
✅ **Upgrade Recommendations** - AI-driven suggestions
✅ **Mobile Responsive** - Flexbox/Grid layouts
✅ **Accessibility** - ARIA labels, keyboard navigation
✅ **Loading States** - Skeleton screens and spinners
✅ **Error Handling** - User-friendly error messages
