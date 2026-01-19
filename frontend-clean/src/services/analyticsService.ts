/**
 * Analytics Service
 *
 * Handles all analytics-related API calls including:
 * - Quota predictions (ML-based)
 * - Usage history
 * - Quota alerts
 * - Storage optimization
 * - File type distribution
 */

import { API_URL } from '../config/constants';

// ==================== Type Definitions ====================

interface QuotaPrediction {
  predicted_date: string;
  predicted_usage_gb: number;
  confidence: number;
  days_until_full: number;
  growth_rate_gb_per_day: number;
  recommendation?: string;
}

interface UsageHistoryEntry {
  date: string;
  storage_used_gb: number;
  files_count: number;
  bandwidth_used_gb?: number;
}

interface UsageHistory {
  history: UsageHistoryEntry[];
  total_days: number;
  average_daily_growth_gb: number;
  trend: 'increasing' | 'decreasing' | 'stable';
}

interface QuotaAlert {
  id: string;
  alert_type: 'quota_warning' | 'quota_critical' | 'quota_exceeded';
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  created_at: string;
  dismissed: boolean;
  threshold_percentage: number;
  current_usage_gb: number;
  quota_gb: number;
}

interface DismissAlertRequest {
  alert_id: string;
}

interface QuotaStats {
  total_quota_gb: number;
  used_gb: number;
  available_gb: number;
  usage_percentage: number;
  files_count: number;
  average_file_size_mb: number;
  largest_file_size_mb: number;
  file_type_distribution: Record<string, number>;
}

interface StorageAnalysis {
  total_size_gb: number;
  file_count: number;
  duplicate_files: {
    count: number;
    wasted_space_gb: number;
  };
  large_files: {
    count: number;
    total_size_gb: number;
    threshold_mb: number;
  };
  old_files: {
    count: number;
    total_size_gb: number;
    days_since_access: number;
  };
  file_type_breakdown: Record<string, { count: number; size_gb: number }>;
}

interface OptimizationSuggestion {
  id: string;
  type: 'duplicate' | 'large_file' | 'old_file' | 'compression' | 'tier_migration';
  title: string;
  description: string;
  potential_savings_gb: number;
  priority: 'low' | 'medium' | 'high';
  action_url?: string;
  dismissed: boolean;
  created_at: string;
}

interface OptimizationSummary {
  total_potential_savings_gb: number;
  suggestions_count: number;
  dismissed_count: number;
  top_opportunity: OptimizationSuggestion | null;
  categories: {
    duplicates: number;
    large_files: number;
    old_files: number;
    compression: number;
    tier_migration: number;
  };
}

interface DashboardData {
  prediction: QuotaPrediction | null;
  history: UsageHistory | null;
  alerts: QuotaAlert[];
  analysis: StorageAnalysis | null;
  suggestions: OptimizationSuggestion[];
  summary: OptimizationSummary | null;
  errors: {
    prediction: Error | null;
    history: Error | null;
    alerts: Error | null;
    analysis: Error | null;
    suggestions: Error | null;
    summary: Error | null;
  };
}

// ==================== Analytics Service Class ====================

class AnalyticsService {
  // ==================== Quota Analytics ====================

  /**
   * Get ML-based quota prediction
   * @param forceRefresh - Force regenerate prediction
   * @returns Quota prediction data
   */
  async getQuotaPrediction(forceRefresh: boolean = false): Promise<QuotaPrediction> {
    const url = `${API_URL}/api/v1/quota/prediction${forceRefresh ? '?force_refresh=true' : ''}`;
    const response = await fetch(url, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch quota prediction: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get usage history
   * @param days - Number of days of history (default: 30)
   * @returns Usage history data
   */
  async getUsageHistory(days: number = 30): Promise<UsageHistory> {
    const response = await fetch(`${API_URL}/api/v1/quota/history?days=${days}`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch usage history: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get quota alerts
   * @returns List of active alerts
   */
  async getQuotaAlerts(): Promise<QuotaAlert[]> {
    const response = await fetch(`${API_URL}/api/v1/quota/alerts`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch quota alerts: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Dismiss a quota alert
   * @param alertId - Alert ID
   * @returns Result
   */
  async dismissAlert(alertId: string): Promise<{ success: boolean }> {
    const requestBody: DismissAlertRequest = { alert_id: alertId };

    const response = await fetch(`${API_URL}/api/v1/quota/alerts/dismiss`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'include',
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`Failed to dismiss alert: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Dismiss all quota alerts
   * @returns Result
   */
  async dismissAllAlerts(): Promise<{ success: boolean; dismissed_count: number }> {
    const response = await fetch(`${API_URL}/api/v1/quota/alerts/dismiss-all`, {
      method: 'POST',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to dismiss all alerts: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get quota statistics
   * @returns Quota statistics
   */
  async getQuotaStats(): Promise<QuotaStats> {
    const response = await fetch(`${API_URL}/api/v1/quota/stats`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch quota stats: ${response.status}`);
    }

    return await response.json();
  }

  // ==================== Storage Optimization ====================

  /**
   * Get storage analysis
   * @returns Storage analysis data
   */
  async getStorageAnalysis(): Promise<StorageAnalysis> {
    const response = await fetch(`${API_URL}/api/v1/storage/optimization/analysis`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch storage analysis: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get optimization suggestions
   * @returns List of suggestions
   */
  async getOptimizationSuggestions(): Promise<OptimizationSuggestion[]> {
    const response = await fetch(`${API_URL}/api/v1/storage/optimization/suggestions`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch optimization suggestions: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get optimization summary
   * @returns Optimization summary
   */
  async getOptimizationSummary(): Promise<OptimizationSummary> {
    const response = await fetch(`${API_URL}/api/v1/storage/optimization/summary`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch optimization summary: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Dismiss an optimization suggestion
   * @param suggestionId - Suggestion ID
   * @returns Result
   */
  async dismissSuggestion(suggestionId: string): Promise<{ success: boolean }> {
    const response = await fetch(
      `${API_URL}/api/v1/storage/optimization/suggestions/${suggestionId}/dismiss`,
      {
        method: 'POST',
        credentials: 'include',
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to dismiss suggestion: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Trigger storage analysis
   * @returns Analysis result
   */
  async triggerAnalysis(): Promise<{ success: boolean; job_id?: string }> {
    const response = await fetch(`${API_URL}/api/v1/storage/optimization/trigger-analysis`, {
      method: 'POST',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to trigger analysis: ${response.status}`);
    }

    return await response.json();
  }

  // ==================== Combined Analytics ====================

  /**
   * Get complete analytics dashboard data
   * @returns All analytics data
   */
  async getDashboardData(): Promise<DashboardData> {
    try {
      const [prediction, history, alerts, analysis, suggestions, summary] =
        await Promise.allSettled([
          this.getQuotaPrediction(),
          this.getUsageHistory(),
          this.getQuotaAlerts(),
          this.getStorageAnalysis(),
          this.getOptimizationSuggestions(),
          this.getOptimizationSummary(),
        ]);

      return {
        prediction: prediction.status === 'fulfilled' ? prediction.value : null,
        history: history.status === 'fulfilled' ? history.value : null,
        alerts: alerts.status === 'fulfilled' ? alerts.value : [],
        analysis: analysis.status === 'fulfilled' ? analysis.value : null,
        suggestions: suggestions.status === 'fulfilled' ? suggestions.value : [],
        summary: summary.status === 'fulfilled' ? summary.value : null,
        errors: {
          prediction: prediction.status === 'rejected' ? (prediction.reason as Error) : null,
          history: history.status === 'rejected' ? (history.reason as Error) : null,
          alerts: alerts.status === 'rejected' ? (alerts.reason as Error) : null,
          analysis: analysis.status === 'rejected' ? (analysis.reason as Error) : null,
          suggestions: suggestions.status === 'rejected' ? (suggestions.reason as Error) : null,
          summary: summary.status === 'rejected' ? (summary.reason as Error) : null,
        },
      };
    } catch (error) {
      console.error('[Analytics] Failed to fetch dashboard data:', error);
      throw error;
    }
  }
}

// Export singleton instance
export const analyticsService = new AnalyticsService();
export default analyticsService;
