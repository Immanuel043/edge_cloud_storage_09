import React, { useState, useEffect } from 'react';
import {
  Target,
  AlertTriangle,
  AlertCircle,
  Bell,
  TrendingUp,
  Calendar,
  HardDrive,
  RefreshCw,
  Check,
  X,
  Loader,
  Info
} from 'lucide-react';
import { API_URL } from '../../config/constants';
import type { QuotaAlertsViewProps, QuotaPrediction, QuotaAlert } from './types';
import { getErrorMessage } from './types';
import { formatBytes } from '../../utils/helpers';

interface AlertSeverity {
  bg: string;
  border: string;
  text: string;
}

/**
 * QuotaAlertsView - Displays storage quota alerts and ML predictions
 */
const QuotaAlertsView: React.FC<QuotaAlertsViewProps> = ({ darkMode, storageStats }) => {
  const [prediction, setPrediction] = useState<QuotaPrediction | null>(null);
  const [alerts, setAlerts] = useState<QuotaAlert[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [dismissing, setDismissing] = useState<string | null>(null);


  const fetchData = async (isRefresh = false): Promise<void> => {
    try {
      if (isRefresh) {
        setRefreshing(true);
      } else {
        setLoading(true);
      }
      setError(null);

      // Fetch prediction and alerts in parallel
      const [predictionRes, alertsRes] = await Promise.allSettled([
        fetch(`${API_URL}/api/v1/quota/prediction`, { credentials: 'include' }),
        fetch(`${API_URL}/api/v1/quota/alerts`, { credentials: 'include' })
      ]);

      if (predictionRes.status === 'fulfilled' && predictionRes.value.ok) {
        const predData = await predictionRes.value.json() as QuotaPrediction;
        setPrediction(predData);
      }

      if (alertsRes.status === 'fulfilled' && alertsRes.value.ok) {
        const alertsData = await alertsRes.value.json() as QuotaAlert[] | { alerts?: QuotaAlert[] };
        // Handle both array and object response formats
        const alertsArray = Array.isArray(alertsData) ? alertsData : (alertsData as { alerts?: QuotaAlert[] }).alerts || [];
        setAlerts(alertsArray);
      }

    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('[QuotaAlerts] Failed to load:', err);
      setError(errorMessage);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const dismissAlert = async (alertId: string): Promise<void> => {
    try {
      setDismissing(alertId);
      const response = await fetch(`${API_URL}/api/v1/quota/alerts/dismiss`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ alert_id: alertId })
      });

      if (response.ok) {
        setAlerts(prev => prev.filter(a => a.id !== alertId));
      }
    } catch (err: unknown) {
      console.error('Failed to dismiss alert:', err);
    } finally {
      setDismissing(null);
    }
  };

  const getAlertIcon = (alertType: string): React.ReactElement => {
    switch (alertType) {
      case '95_percent':
        return <AlertTriangle className="text-red-500" size={20} />;
      case '85_percent':
        return <AlertCircle className="text-orange-500" size={20} />;
      case '70_percent':
        return <Bell className="text-yellow-500" size={20} />;
      case 'predicted_full':
        return <TrendingUp className="text-purple-500" size={20} />;
      default:
        return <Info className="text-blue-500" size={20} />;
    }
  };

  const getAlertSeverity = (alertType: string): AlertSeverity => {
    switch (alertType) {
      case '95_percent':
        return { bg: 'bg-red-100 dark:bg-red-900/30', border: 'border-red-300 dark:border-red-700', text: 'Critical' };
      case '85_percent':
        return { bg: 'bg-orange-100 dark:bg-orange-900/30', border: 'border-orange-300 dark:border-orange-700', text: 'Warning' };
      case '70_percent':
        return { bg: 'bg-yellow-100 dark:bg-yellow-900/30', border: 'border-yellow-300 dark:border-yellow-700', text: 'Notice' };
      case 'predicted_full':
        return { bg: 'bg-purple-100 dark:bg-purple-900/30', border: 'border-purple-300 dark:border-purple-700', text: 'Prediction' };
      default:
        return { bg: 'bg-blue-100 dark:bg-blue-900/30', border: 'border-blue-300 dark:border-blue-700', text: 'Info' };
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-4">
        <Loader className="animate-spin text-blue-500" size={48} />
        <p className={`${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          Loading quota alerts...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <div className="flex items-center gap-3 mb-4 text-red-500">
          <AlertCircle size={24} />
          <h2 className="text-lg font-semibold">Failed to Load Quota Alerts</h2>
        </div>
        <p className={`mb-4 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>{error}</p>
        <button
          onClick={() => fetchData()}
          className="px-4 py-2 bg-gradient-to-r from-blue-500 to-purple-600 text-white rounded-lg hover:from-blue-600 hover:to-purple-700 transition-all"
          type="button"
        >
          Retry
        </button>
      </div>
    );
  }

  const usagePercent = storageStats?.percentage_used || (prediction?.usage_percent ? prediction.usage_percent * 100 : 0) || 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <div className="flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3 mb-2">
              <Target size={24} className="text-blue-500" />
              <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Quota Alerts
              </h1>
            </div>
            <p className={`${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              Monitor your storage usage and predictive warnings
            </p>
          </div>
          <button
            onClick={() => fetchData(true)}
            disabled={refreshing}
            className={`p-2 rounded-lg transition-colors ${
              darkMode
                ? 'hover:bg-gray-700 text-gray-400'
                : 'hover:bg-gray-100 text-gray-600'
            } ${refreshing ? 'opacity-50 cursor-not-allowed' : ''}`}
            title="Refresh"
            type="button"
          >
            <RefreshCw size={20} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Current Usage Card */}
      <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <h2 className={`text-lg font-semibold mb-4 flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          <HardDrive size={20} className="text-blue-500" />
          Current Storage Usage
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Usage Progress */}
          <div className="md:col-span-2">
            <div className="flex justify-between mb-2">
              <span className={darkMode ? 'text-gray-300' : 'text-gray-700'}>
                {formatBytes(storageStats?.used || prediction?.current_usage_bytes || 0)}
              </span>
              <span className={darkMode ? 'text-gray-400' : 'text-gray-500'}>
                {formatBytes(storageStats?.quota || prediction?.quota_bytes || 0)}
              </span>
            </div>
            <div className="w-full bg-gray-300 dark:bg-gray-600 rounded-full h-4 overflow-hidden">
              <div
                className="h-full rounded-full transition-all duration-500"
                style={{
                  width: `${Math.min(usagePercent, 100)}%`,
                  background: usagePercent > 90
                    ? '#ef4444'
                    : usagePercent > 70
                      ? '#f59e0b'
                      : 'linear-gradient(to right, #3b82f6, #8b5cf6)'
                }}
              />
            </div>
            <p className={`mt-2 text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              {usagePercent.toFixed(1)}% of your storage quota used
            </p>
          </div>

          {/* Status Badge */}
          <div className="flex items-center justify-center">
            <div className={`px-4 py-2 rounded-full font-medium ${
              usagePercent > 90
                ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                : usagePercent > 70
                  ? 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400'
                  : 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
            }`}>
              {usagePercent > 90 ? 'Critical' : usagePercent > 70 ? 'Warning' : 'Healthy'}
            </div>
          </div>
        </div>
      </div>

      {/* Prediction Card */}
      {prediction && (
        <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
          <h2 className={`text-lg font-semibold mb-4 flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            <TrendingUp size={20} className="text-purple-500" />
            ML-Based Predictions
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {/* Days Until Full */}
            <div className={`p-4 rounded-lg border ${darkMode ? 'border-gray-700 bg-gray-750' : 'border-gray-200 bg-gray-50'}`}>
              <div className="flex items-center gap-2 mb-2">
                <Calendar size={16} className="text-blue-500" />
                <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Days Until Full</span>
              </div>
              <p className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                {prediction.days_until_full !== null ? prediction.days_until_full : 'N/A'}
              </p>
              {prediction.will_exceed_quota && (
                <p className="text-xs text-red-500 mt-1">Will exceed quota within 30 days</p>
              )}
            </div>

            {/* 7-Day Prediction */}
            <div className={`p-4 rounded-lg border ${darkMode ? 'border-gray-700 bg-gray-750' : 'border-gray-200 bg-gray-50'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>7-Day Forecast</span>
                <span className="text-xs text-green-500">{((prediction.confidence_7d || 0) * 100).toFixed(0)}% conf</span>
              </div>
              <p className={`text-lg font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                {formatBytes(prediction.predicted_7d || 0)}
              </p>
            </div>

            {/* 14-Day Prediction */}
            <div className={`p-4 rounded-lg border ${darkMode ? 'border-gray-700 bg-gray-750' : 'border-gray-200 bg-gray-50'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>14-Day Forecast</span>
                <span className="text-xs text-green-500">{((prediction.confidence_14d || 0) * 100).toFixed(0)}% conf</span>
              </div>
              <p className={`text-lg font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                {formatBytes(prediction.predicted_14d || 0)}
              </p>
            </div>

            {/* 30-Day Prediction */}
            <div className={`p-4 rounded-lg border ${darkMode ? 'border-gray-700 bg-gray-750' : 'border-gray-200 bg-gray-50'}`}>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>30-Day Forecast</span>
                <span className="text-xs text-green-500">{((prediction.confidence_30d || 0) * 100).toFixed(0)}% conf</span>
              </div>
              <p className={`text-lg font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                {formatBytes(prediction.predicted_30d || 0)}
              </p>
            </div>
          </div>

          {prediction.model_type && (
            <p className={`mt-4 text-xs ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
              Prediction model: {prediction.model_type} | Last updated: {prediction.prediction_date ? new Date(prediction.prediction_date).toLocaleString() : 'N/A'}
            </p>
          )}
        </div>
      )}

      {/* Active Alerts */}
      <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <h2 className={`text-lg font-semibold mb-4 flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          <Bell size={20} className="text-yellow-500" />
          Active Alerts
          {alerts.length > 0 && (
            <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400 rounded-full">
              {alerts.length}
            </span>
          )}
        </h2>

        {alerts.length === 0 ? (
          <div className={`text-center py-8 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            <Check size={48} className="mx-auto mb-3 text-green-500" />
            <p className="text-lg font-medium">No Active Alerts</p>
            <p className="text-sm mt-1">Your storage usage is within healthy limits.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {alerts.map((alert) => {
              const severity = getAlertSeverity(alert.alert_type);
              return (
                <div
                  key={alert.id}
                  className={`p-4 rounded-lg border ${severity.bg} ${severity.border} transition-all`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      {getAlertIcon(alert.alert_type)}
                      <div>
                        <div className="flex items-center gap-2">
                          <span className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                            {alert.message}
                          </span>
                          <span className={`px-2 py-0.5 text-xs rounded ${
                            alert.alert_type === '95_percent' ? 'bg-red-200 text-red-800' :
                            alert.alert_type === '85_percent' ? 'bg-orange-200 text-orange-800' :
                            alert.alert_type === '70_percent' ? 'bg-yellow-200 text-yellow-800' :
                            'bg-purple-200 text-purple-800'
                          }`}>
                            {severity.text}
                          </span>
                        </div>
                        <p className={`text-sm mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                          Current usage: {formatBytes(alert.current_usage_bytes)} / {formatBytes(alert.quota_bytes)} ({alert.usage_percent?.toFixed(1)}%)
                        </p>
                        <p className={`text-xs mt-1 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                          {new Date(alert.created_at).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => dismissAlert(alert.id)}
                      disabled={dismissing === alert.id}
                      className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700 transition-colors ${
                        dismissing === alert.id ? 'opacity-50 cursor-not-allowed' : ''
                      }`}
                      title="Dismiss alert"
                      type="button"
                    >
                      {dismissing === alert.id ? (
                        <Loader size={16} className="animate-spin" />
                      ) : (
                        <X size={16} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />
                      )}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Tips Card */}
      <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <h2 className={`text-lg font-semibold mb-4 flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          <Info size={20} className="text-blue-500" />
          Storage Tips
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className={`p-3 rounded-lg ${darkMode ? 'bg-gray-750' : 'bg-gray-50'}`}>
            <p className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              <strong>Delete unused files:</strong> Check your Trash and remove files you no longer need.
            </p>
          </div>
          <div className={`p-3 rounded-lg ${darkMode ? 'bg-gray-750' : 'bg-gray-50'}`}>
            <p className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              <strong>Use deduplication:</strong> Our smart dedup can save up to 60% storage by removing duplicate content.
            </p>
          </div>
          <div className={`p-3 rounded-lg ${darkMode ? 'bg-gray-750' : 'bg-gray-50'}`}>
            <p className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              <strong>Archive old files:</strong> Move rarely accessed files to cold storage tier.
            </p>
          </div>
          <div className={`p-3 rounded-lg ${darkMode ? 'bg-gray-750' : 'bg-gray-50'}`}>
            <p className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              <strong>Upgrade your plan:</strong> Need more space? Consider upgrading to Business or Enterprise.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default QuotaAlertsView;
