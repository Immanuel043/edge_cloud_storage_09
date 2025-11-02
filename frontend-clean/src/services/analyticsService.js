import { API_URL } from '../config/constants';

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

class AnalyticsService {
  // ==================== Quota Analytics ====================

  /**
   * Get ML-based quota prediction
   * @param {boolean} forceRefresh - Force regenerate prediction
   * @returns {Promise<Object>} Quota prediction data
   */
  async getQuotaPrediction(forceRefresh = false) {
    const url = `${API_URL}/api/v1/quota/prediction${forceRefresh ? '?force_refresh=true' : ''}`;
    const response = await fetch(url, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch quota prediction: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get usage history
   * @param {number} days - Number of days of history (default: 30)
   * @returns {Promise<Object>} Usage history data
   */
  async getUsageHistory(days = 30) {
    const response = await fetch(`${API_URL}/api/v1/quota/history?days=${days}`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch usage history: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get quota alerts
   * @returns {Promise<Array>} List of active alerts
   */
  async getQuotaAlerts() {
    const response = await fetch(`${API_URL}/api/v1/quota/alerts`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch quota alerts: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Dismiss a quota alert
   * @param {string} alertId - Alert ID
   * @returns {Promise<Object>} Result
   */
  async dismissAlert(alertId) {
    const response = await fetch(`${API_URL}/api/v1/quota/alerts/dismiss`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      credentials: 'include',
      body: JSON.stringify({ alert_id: alertId })
    });

    if (!response.ok) {
      throw new Error(`Failed to dismiss alert: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Dismiss all quota alerts
   * @returns {Promise<Object>} Result
   */
  async dismissAllAlerts() {
    const response = await fetch(`${API_URL}/api/v1/quota/alerts/dismiss-all`, {
      method: 'POST',
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to dismiss all alerts: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get quota statistics
   * @returns {Promise<Object>} Quota statistics
   */
  async getQuotaStats() {
    const response = await fetch(`${API_URL}/api/v1/quota/stats`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch quota stats: ${response.status}`);
    }

    return await response.json();
  }

  // ==================== Storage Optimization ====================

  /**
   * Get storage analysis
   * @returns {Promise<Object>} Storage analysis data
   */
  async getStorageAnalysis() {
    const response = await fetch(`${API_URL}/api/v1/storage-optimization/analysis`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch storage analysis: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get optimization suggestions
   * @returns {Promise<Array>} List of suggestions
   */
  async getOptimizationSuggestions() {
    const response = await fetch(`${API_URL}/api/v1/storage-optimization/suggestions`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch optimization suggestions: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get optimization summary
   * @returns {Promise<Object>} Optimization summary
   */
  async getOptimizationSummary() {
    const response = await fetch(`${API_URL}/api/v1/storage-optimization/summary`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch optimization summary: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Dismiss an optimization suggestion
   * @param {string} suggestionId - Suggestion ID
   * @returns {Promise<Object>} Result
   */
  async dismissSuggestion(suggestionId) {
    const response = await fetch(
      `${API_URL}/api/v1/storage-optimization/suggestions/${suggestionId}/dismiss`,
      {
        method: 'POST',
        credentials: 'include'
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to dismiss suggestion: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Trigger storage analysis
   * @returns {Promise<Object>} Analysis result
   */
  async triggerAnalysis() {
    const response = await fetch(`${API_URL}/api/v1/storage-optimization/trigger-analysis`, {
      method: 'POST',
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to trigger analysis: ${response.status}`);
    }

    return await response.json();
  }

  // ==================== Combined Analytics ====================

  /**
   * Get complete analytics dashboard data
   * @returns {Promise<Object>} All analytics data
   */
  async getDashboardData() {
    try {
      const [
        prediction,
        history,
        alerts,
        analysis,
        suggestions,
        summary
      ] = await Promise.allSettled([
        this.getQuotaPrediction(),
        this.getUsageHistory(),
        this.getQuotaAlerts(),
        this.getStorageAnalysis(),
        this.getOptimizationSuggestions(),
        this.getOptimizationSummary()
      ]);

      return {
        prediction: prediction.status === 'fulfilled' ? prediction.value : null,
        history: history.status === 'fulfilled' ? history.value : null,
        alerts: alerts.status === 'fulfilled' ? alerts.value : [],
        analysis: analysis.status === 'fulfilled' ? analysis.value : null,
        suggestions: suggestions.status === 'fulfilled' ? suggestions.value : [],
        summary: summary.status === 'fulfilled' ? summary.value : null,
        errors: {
          prediction: prediction.status === 'rejected' ? prediction.reason : null,
          history: history.status === 'rejected' ? history.reason : null,
          alerts: alerts.status === 'rejected' ? alerts.reason : null,
          analysis: analysis.status === 'rejected' ? analysis.reason : null,
          suggestions: suggestions.status === 'rejected' ? suggestions.reason : null,
          summary: summary.status === 'rejected' ? summary.reason : null
        }
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
