import React, { useState, useEffect } from 'react';
import {
  BarChart3,
  TrendingUp,
  HardDrive,
  FileText,
  Image,
  Video,
  Music,
  Archive,
  Code,
  Loader,
  AlertTriangle,
  CheckCircle,
  Target,
  Sparkles,
  Brain,
  Clock,
  Zap,
  TrendingDown,
  AlertCircle,
  X,
  RefreshCw,
  Calendar,
  Activity
} from 'lucide-react';
import { analyticsService } from '../../services/analyticsService';
import { formatBytes, formatDate } from '../../utils/helpers';

export default function EnhancedAnalyticsView({ darkMode, storageStats }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const loadAnalytics = async (forceRefresh = false) => {
    try {
      setLoading(!forceRefresh);
      setRefreshing(forceRefresh);
      setError(null);

      const analyticsData = await analyticsService.getDashboardData();
      setData(analyticsData);
    } catch (err) {
      console.error('[Analytics] Failed to load:', err);
      setError(err.message);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    loadAnalytics();
  }, []);

  const handleDismissAlert = async (alertId) => {
    try {
      await analyticsService.dismissAlert(alertId);
      // Refresh alerts
      const alerts = await analyticsService.getQuotaAlerts();
      setData(prev => ({ ...prev, alerts }));
    } catch (err) {
      console.error('[Analytics] Failed to dismiss alert:', err);
    }
  };

  const handleDismissSuggestion = async (suggestionId) => {
    try {
      await analyticsService.dismissSuggestion(suggestionId);
      // Refresh suggestions
      const suggestions = await analyticsService.getOptimizationSuggestions();
      setData(prev => ({ ...prev, suggestions }));
    } catch (err) {
      console.error('[Analytics] Failed to dismiss suggestion:', err);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-4">
        <Loader className="animate-spin text-blue-500" size={48} />
        <p className={`${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          Loading analytics data...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <div className="flex items-center gap-3 mb-4 text-red-500">
          <AlertCircle size={24} />
          <h2 className="text-lg font-semibold">Failed to Load Analytics</h2>
        </div>
        <p className={`mb-4 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          {error}
        </p>
        <button
          onClick={() => loadAnalytics(true)}
          className="px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
        >
          Retry
        </button>
      </div>
    );
  }

  const { prediction, history, alerts, analysis, suggestions, summary } = data || {};

  return (
    <div className="space-y-6">
      {/* Header with Refresh */}
      <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <BarChart3 size={24} className="text-[#0033A0]" />
            <div>
              <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Analytics Dashboard
              </h1>
              <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                AI-powered insights and predictions
              </p>
            </div>
          </div>
          <button
            onClick={() => loadAnalytics(true)}
            disabled={refreshing}
            className={`p-2 rounded-lg transition-colors ${
              darkMode
                ? 'hover:bg-gray-700 text-gray-400'
                : 'hover:bg-gray-100 text-gray-600'
            } ${refreshing ? 'opacity-50 cursor-not-allowed' : ''}`}
            title="Refresh analytics"
          >
            <RefreshCw size={20} className={refreshing ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Quota Prediction */}
      {prediction && (
        <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
          <div className="flex items-center gap-3 mb-4">
            <Brain size={20} className="text-purple-500" />
            <h2 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Quota Prediction (ML-Powered)
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <PredictionCard
              darkMode={darkMode}
              title="7 Days"
              predicted={prediction.predicted_7d}
              quota={prediction.quota_bytes}
              confidence={prediction.confidence_7d}
            />
            <PredictionCard
              darkMode={darkMode}
              title="14 Days"
              predicted={prediction.predicted_14d}
              quota={prediction.quota_bytes}
              confidence={prediction.confidence_14d}
            />
            <PredictionCard
              darkMode={darkMode}
              title="30 Days"
              predicted={prediction.predicted_30d}
              quota={prediction.quota_bytes}
              confidence={prediction.confidence_30d}
            />
          </div>

          {prediction.days_until_full && (
            <div className={`p-4 rounded-lg border-l-4 ${
              prediction.days_until_full <= 7
                ? 'border-red-500 bg-red-50 dark:bg-red-900/20'
                : prediction.days_until_full <= 14
                ? 'border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20'
                : 'border-green-500 bg-green-50 dark:bg-green-900/20'
            }`}>
              <div className="flex items-center gap-2">
                <Clock size={16} />
                <span className="font-semibold">
                  {prediction.days_until_full} days until quota full
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Active Alerts */}
      {alerts && alerts.length > 0 && (
        <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
          <div className="flex items-center gap-3 mb-4">
            <AlertTriangle size={20} className="text-yellow-500" />
            <h2 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Active Alerts ({alerts.length})
            </h2>
          </div>

          <div className="space-y-3">
            {alerts.map((alert) => (
              <div
                key={alert.id}
                className={`p-4 rounded-lg border ${
                  darkMode ? 'border-gray-700 bg-gray-750' : 'border-gray-200'
                } flex items-start justify-between`}
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <span className={`text-sm font-medium ${
                      alert.severity === 'critical'
                        ? 'text-red-500'
                        : alert.severity === 'warning'
                        ? 'text-yellow-500'
                        : 'text-blue-500'
                    }`}>
                      {alert.alert_type.replace('_', ' ').toUpperCase()}
                    </span>
                  </div>
                  <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                    {alert.message}
                  </p>
                  <p className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-400'} mt-1`}>
                    {formatDate(alert.created_at)}
                  </p>
                </div>
                <button
                  onClick={() => handleDismissAlert(alert.id)}
                  className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600`}
                >
                  <X size={16} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Optimization Suggestions */}
      {suggestions && suggestions.length > 0 && (
        <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
          <div className="flex items-center gap-3 mb-4">
            <Sparkles size={20} className="text-blue-500" />
            <h2 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Optimization Suggestions ({suggestions.length})
            </h2>
          </div>

          <div className="space-y-3">
            {suggestions.map((suggestion) => (
              <div
                key={suggestion.id}
                className={`p-4 rounded-lg border ${
                  darkMode ? 'border-gray-700 bg-gray-750' : 'border-gray-200'
                }`}
              >
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-2">
                      <span className={`px-2 py-1 rounded text-xs font-medium ${
                        suggestion.impact === 'high'
                          ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
                          : suggestion.impact === 'medium'
                          ? 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400'
                          : 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400'
                      }`}>
                        {suggestion.impact.toUpperCase()} IMPACT
                      </span>
                      {suggestion.potential_savings && (
                        <span className={`text-sm font-semibold ${darkMode ? 'text-green-400' : 'text-green-600'}`}>
                          Save {formatBytes(suggestion.potential_savings)}
                        </span>
                      )}
                    </div>
                    <p className={`text-sm ${darkMode ? 'text-white' : 'text-gray-900'} font-medium mb-1`}>
                      {suggestion.title}
                    </p>
                    <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                      {suggestion.description}
                    </p>
                  </div>
                  <button
                    onClick={() => handleDismissSuggestion(suggestion.id)}
                    className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 ml-2`}
                  >
                    <X size={16} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Storage Analysis */}
      {analysis && (
        <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
          <div className="flex items-center gap-3 mb-4">
            <HardDrive size={20} className="text-blue-500" />
            <h2 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Storage Breakdown
            </h2>
          </div>

          {analysis.file_type_distribution && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {Object.entries(analysis.file_type_distribution).map(([type, data]) => (
                <FileTypeCard
                  key={type}
                  darkMode={darkMode}
                  type={type}
                  count={data.count}
                  size={data.size}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Usage History Chart */}
      {history && history.history && history.history.length > 0 && (
        <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
          <div className="flex items-center gap-3 mb-4">
            <Activity size={20} className="text-purple-500" />
            <h2 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Usage Trend
            </h2>
          </div>

          <div className="space-y-2">
            {history.history.slice(-7).map((point, index) => (
              <div
                key={index}
                className={`flex items-center justify-between p-3 rounded-lg ${
                  darkMode ? 'bg-gray-750' : 'bg-gray-50'
                }`}
              >
                <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  {formatDate(point.timestamp)}
                </span>
                <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  {formatBytes(point.bytes_used)}
                </span>
                {index > 0 && (
                  <span className={`text-xs flex items-center gap-1 ${
                    point.bytes_used > history.history[index - 1].bytes_used
                      ? 'text-red-500'
                      : 'text-green-500'
                  }`}>
                    {point.bytes_used > history.history[index - 1].bytes_used ? (
                      <>
                        <TrendingUp size={12} />
                        +{formatBytes(point.bytes_used - history.history[index - 1].bytes_used)}
                      </>
                    ) : (
                      <>
                        <TrendingDown size={12} />
                        -{formatBytes(history.history[index - 1].bytes_used - point.bytes_used)}
                      </>
                    )}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Summary Stats */}
      {summary && (
        <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
          <h2 className={`text-lg font-semibold mb-4 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            Optimization Summary
          </h2>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <SummaryCard
              darkMode={darkMode}
              icon={Zap}
              label="Potential Savings"
              value={formatBytes(summary.total_potential_savings || 0)}
              color="green"
            />
            <SummaryCard
              darkMode={darkMode}
              icon={Target}
              label="Active Suggestions"
              value={summary.active_suggestions || 0}
              color="blue"
            />
            <SummaryCard
              darkMode={darkMode}
              icon={CheckCircle}
              label="Applied"
              value={summary.applied_suggestions || 0}
              color="purple"
            />
            <SummaryCard
              darkMode={darkMode}
              icon={Activity}
              label="Efficiency Score"
              value={`${Math.round((summary.efficiency_score || 0) * 100)}%`}
              color="yellow"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// Helper Components

function PredictionCard({ darkMode, title, predicted, quota, confidence }) {
  const percentage = (predicted / quota) * 100;
  const isWarning = percentage > 80;

  return (
    <div className={`p-4 rounded-lg border ${
      darkMode ? 'border-gray-700 bg-gray-750' : 'border-gray-200'
    }`}>
      <div className="text-center">
        <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'} mb-1`}>
          {title}
        </p>
        <p className={`text-2xl font-bold mb-1 ${
          isWarning
            ? 'text-yellow-500'
            : darkMode
            ? 'text-white'
            : 'text-gray-900'
        }`}>
          {formatBytes(predicted)}
        </p>
        <p className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
          {Math.round(percentage)}% of quota
        </p>
        <div className="mt-2 flex items-center justify-center gap-1">
          <div className={`text-xs px-2 py-1 rounded ${
            darkMode ? 'bg-gray-800' : 'bg-gray-100'
          }`}>
            {Math.round(confidence * 100)}% confidence
          </div>
        </div>
      </div>
    </div>
  );
}

function FileTypeCard({ darkMode, type, count, size }) {
  const icons = {
    documents: FileText,
    images: Image,
    videos: Video,
    audio: Music,
    archives: Archive,
    code: Code
  };

  const Icon = icons[type.toLowerCase()] || FileText;

  return (
    <div className={`p-4 rounded-lg border ${
      darkMode ? 'border-gray-700 bg-gray-750' : 'border-gray-200'
    }`}>
      <div className="flex items-center gap-3 mb-2">
        <Icon size={20} className="text-blue-500" />
        <span className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          {type}
        </span>
      </div>
      <div className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
        <p>{count} files</p>
        <p className="font-semibold">{formatBytes(size)}</p>
      </div>
    </div>
  );
}

function SummaryCard({ darkMode, icon: Icon, label, value, color }) {
  const colors = {
    green: 'text-green-500',
    blue: 'text-blue-500',
    purple: 'text-purple-500',
    yellow: 'text-yellow-500'
  };

  return (
    <div className={`p-4 rounded-lg border ${
      darkMode ? 'border-gray-700 bg-gray-750' : 'border-gray-200'
    } text-center`}>
      <Icon size={24} className={`mx-auto mb-2 ${colors[color]}`} />
      <p className={`text-2xl font-bold mb-1 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
        {value}
      </p>
      <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
        {label}
      </p>
    </div>
  );
}
