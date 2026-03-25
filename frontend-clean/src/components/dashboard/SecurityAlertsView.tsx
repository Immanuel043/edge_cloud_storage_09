import React, { useState, useEffect, useCallback } from 'react';
import { Shield, AlertTriangle, XCircle, CheckCircle, RefreshCw } from 'lucide-react';
import {
  getAlerts,
  dismissAlert,
  getAlertsSummary,
  type SecurityAlert,
  type AlertsSummary,
} from '../../services/securityService';

interface SecurityAlertsViewProps {
  darkMode: boolean;
}

const SEVERITY_CONFIG: Record<string, { color: string; darkColor: string; icon: typeof AlertTriangle }> = {
  critical: { color: 'bg-red-100 text-red-800 border-red-200', darkColor: 'bg-red-900/30 text-red-400 border-red-800', icon: XCircle },
  high: { color: 'bg-orange-100 text-orange-800 border-orange-200', darkColor: 'bg-orange-900/30 text-orange-400 border-orange-800', icon: AlertTriangle },
  medium: { color: 'bg-yellow-100 text-yellow-800 border-yellow-200', darkColor: 'bg-yellow-900/30 text-yellow-400 border-yellow-800', icon: AlertTriangle },
  low: { color: 'bg-blue-100 text-blue-800 border-blue-200', darkColor: 'bg-blue-900/30 text-blue-400 border-blue-800', icon: Shield },
};

const SecurityAlertsView: React.FC<SecurityAlertsViewProps> = ({ darkMode }) => {
  const [alerts, setAlerts] = useState<SecurityAlert[]>([]);
  const [summary, setSummary] = useState<AlertsSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<'all' | 'open' | 'resolved'>('open');

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const statusParam = filter === 'all' ? undefined : filter === 'resolved' ? 'resolved' : 'open';
      const [alertsRes, summaryRes] = await Promise.all([
        getAlerts({ ...(statusParam ? { status: statusParam } : {}), limit: 50 }),
        getAlertsSummary(),
      ]);
      setAlerts(alertsRes.alerts);
      setSummary(summaryRes);
    } catch {
      // Ignore
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleDismiss = async (alertId: string) => {
    try {
      await dismissAlert(alertId);
      setAlerts(prev => prev.filter(a => a.id !== alertId));
      setSummary(prev => prev ? { ...prev, total: Math.max(0, prev.total - 1) } : prev);
    } catch {
      // Ignore
    }
  };

  return (
    <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Shield className={`w-6 h-6 ${darkMode ? 'text-blue-400' : 'text-blue-600'}`} />
          <h2 className={`text-xl font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            Security Alerts
          </h2>
          {summary && summary.total > 0 && (
            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
              {summary.total} open
            </span>
          )}
        </div>
        <button
          onClick={loadData}
          className={`p-2 rounded-lg transition-colors ${darkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
        >
          <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Summary Bar */}
      {summary && summary.total > 0 && (
        <div className={`flex gap-4 mb-6 p-3 rounded-lg ${darkMode ? 'bg-gray-700/50' : 'bg-gray-50'}`}>
          {Object.entries(summary.by_severity).map(([sev, count]) => (
            <div key={sev} className="flex items-center gap-2 text-sm">
              <span className={`w-2 h-2 rounded-full ${
                sev === 'critical' ? 'bg-red-500' :
                sev === 'high' ? 'bg-orange-500' :
                sev === 'medium' ? 'bg-yellow-500' : 'bg-blue-500'
              }`} />
              <span className={darkMode ? 'text-gray-300' : 'text-gray-700'}>
                {count} {sev}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* Filter Tabs */}
      <div className={`flex gap-1 mb-4 p-1 rounded-lg ${darkMode ? 'bg-gray-700/50' : 'bg-gray-100'}`}>
        {(['open', 'resolved', 'all'] as const).map(f => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`flex-1 px-3 py-1.5 rounded text-sm font-medium transition-colors ${
              filter === f
                ? darkMode ? 'bg-gray-600 text-white' : 'bg-white text-gray-900 shadow-sm'
                : darkMode ? 'text-gray-400 hover:text-gray-300' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {f.charAt(0).toUpperCase() + f.slice(1)}
          </button>
        ))}
      </div>

      {/* Alerts List */}
      {loading ? (
        <div className="flex items-center justify-center py-12">
          <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : alerts.length === 0 ? (
        <div className="text-center py-12">
          <CheckCircle className={`mx-auto mb-3 ${darkMode ? 'text-green-400' : 'text-green-500'}`} size={48} />
          <p className={`text-lg font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            No {filter === 'all' ? '' : filter} alerts
          </p>
          <p className={`text-sm mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            Your account activity looks normal.
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {alerts.map(alert => {
            const config = SEVERITY_CONFIG[alert.severity] ?? SEVERITY_CONFIG['low']!;
            const Icon = config.icon;
            return (
              <div
                key={alert.id}
                className={`p-4 rounded-lg border ${darkMode ? config.darkColor : config.color}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3 flex-1">
                    <Icon className="w-5 h-5 flex-shrink-0 mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-sm">{alert.title}</p>
                      {alert.description && (
                        <p className="text-xs mt-1 opacity-80">{alert.description}</p>
                      )}
                      <div className="flex items-center gap-3 mt-2 text-xs opacity-60">
                        <span>{alert.alert_type.replace('_', ' ')}</span>
                        {alert.detected_at && (
                          <span>{new Date(alert.detected_at).toLocaleString()}</span>
                        )}
                        <span>Risk: {alert.risk_score}/100</span>
                      </div>
                    </div>
                  </div>
                  {alert.status === 'open' && (
                    <button
                      onClick={() => handleDismiss(alert.id)}
                      className={`px-3 py-1 rounded text-xs font-medium transition-colors flex-shrink-0 ${
                        darkMode
                          ? 'bg-gray-600 hover:bg-gray-500 text-gray-200'
                          : 'bg-white hover:bg-gray-50 text-gray-700 border border-gray-200'
                      }`}
                    >
                      Dismiss
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default SecurityAlertsView;
