import { API_URL } from '../config/constants';

/**
 * Organization Service
 *
 * Handles all auto-organization related API calls including:
 * - ML clustering analysis
 * - Cluster management (apply, dismiss)
 * - Organization rules CRUD
 */

class OrganizationService {
  // ==================== ML Clustering ====================

  /**
   * Start ML-based organization analysis
   * @param {Object} params - Organization parameters
   * @param {string} params.algorithm - 'kmeans' or 'dbscan'
   * @param {number} params.numClusters - Number of clusters (for kmeans)
   * @param {number} params.minFiles - Minimum files per cluster
   * @param {boolean} params.previewOnly - Preview without applying
   * @returns {Promise<Object>} Organization session result
   */
  async startOrganization({ algorithm = 'kmeans', numClusters = 5, minFiles = 3, previewOnly = true } = {}) {
    const response = await fetch(`${API_URL}/api/v1/organization/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        algorithm,
        num_clusters: numClusters,
        min_files: minFiles,
        preview_only: previewOnly
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `Failed to start organization: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get organization clusters
   * @param {Object} options - Query options
   * @param {boolean} options.includeApplied - Include already-applied clusters
   * @param {string} options.algorithm - Filter by algorithm
   * @returns {Promise<Array>} List of clusters
   */
  async getClusters({ includeApplied = false, algorithm = null } = {}) {
    const params = new URLSearchParams();
    if (includeApplied) params.append('include_applied', 'true');
    if (algorithm) params.append('algorithm', algorithm);

    const response = await fetch(`${API_URL}/api/v1/organization/clusters?${params}`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch clusters: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Apply cluster organization
   * @param {string} clusterId - Cluster ID
   * @param {string} targetFolderPath - Optional custom target path
   * @returns {Promise<Object>} Application result
   */
  async applyCluster(clusterId, targetFolderPath = null) {
    const response = await fetch(`${API_URL}/api/v1/organization/clusters/${clusterId}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        target_folder_path: targetFolderPath
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `Failed to apply cluster: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Dismiss cluster suggestion
   * @param {string} clusterId - Cluster ID
   * @returns {Promise<Object>} Result
   */
  async dismissCluster(clusterId) {
    const response = await fetch(`${API_URL}/api/v1/organization/clusters/${clusterId}/dismiss`, {
      method: 'POST',
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to dismiss cluster: ${response.status}`);
    }

    return await response.json();
  }

  // ==================== Organization Rules ====================

  /**
   * Get organization rules
   * @param {boolean} includeInactive - Include inactive rules
   * @returns {Promise<Array>} List of rules
   */
  async getRules(includeInactive = false) {
    const params = new URLSearchParams();
    if (includeInactive) params.append('include_inactive', 'true');

    const response = await fetch(`${API_URL}/api/v1/organization/rules?${params}`, {
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch rules: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Create organization rule
   * @param {Object} rule - Rule parameters
   * @returns {Promise<Object>} Created rule
   */
  async createRule(rule) {
    const response = await fetch(`${API_URL}/api/v1/organization/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        rule_name: rule.ruleName,
        rule_type: rule.ruleType,
        target_folder_path: rule.targetFolderPath,
        pattern: rule.pattern,
        file_extensions: rule.fileExtensions,
        keywords: rule.keywords,
        date_field: rule.dateField,
        date_range_days: rule.dateRangeDays,
        create_subfolder_by_date: rule.createSubfolderByDate,
        auto_apply: rule.autoApply,
        priority: rule.priority
      })
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.detail || `Failed to create rule: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Update organization rule
   * @param {string} ruleId - Rule ID
   * @param {Object} updates - Update parameters
   * @returns {Promise<Object>} Updated rule
   */
  async updateRule(ruleId, updates) {
    const response = await fetch(`${API_URL}/api/v1/organization/rules/${ruleId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        is_active: updates.isActive,
        auto_apply: updates.autoApply,
        priority: updates.priority,
        target_folder_path: updates.targetFolderPath
      })
    });

    if (!response.ok) {
      throw new Error(`Failed to update rule: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Delete organization rule
   * @param {string} ruleId - Rule ID
   * @returns {Promise<Object>} Result
   */
  async deleteRule(ruleId) {
    const response = await fetch(`${API_URL}/api/v1/organization/rules/${ruleId}`, {
      method: 'DELETE',
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to delete rule: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Apply all active rules
   * @returns {Promise<Object>} Application result
   */
  async applyRules() {
    const response = await fetch(`${API_URL}/api/v1/organization/rules/apply`, {
      method: 'POST',
      credentials: 'include'
    });

    if (!response.ok) {
      throw new Error(`Failed to apply rules: ${response.status}`);
    }

    return await response.json();
  }
}

export const organizationService = new OrganizationService();
export default organizationService;
