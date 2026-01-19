/**
 * Organization Service
 *
 * Handles all auto-organization related API calls including:
 * - ML clustering analysis
 * - Cluster management (apply, dismiss)
 * - Organization rules CRUD
 */

import { API_URL } from '../config/constants';

// ==================== Type Definitions ====================

type ClusteringAlgorithm = 'kmeans' | 'dbscan';

type RuleType = 'file_extension' | 'keyword' | 'date' | 'size' | 'pattern';

interface StartOrganizationParams {
  algorithm?: ClusteringAlgorithm | undefined;
  numClusters?: number | undefined;
  minFiles?: number | undefined;
  previewOnly?: boolean | undefined;
}

interface StartOrganizationRequest {
  algorithm: ClusteringAlgorithm;
  num_clusters: number;
  min_files: number;
  preview_only: boolean;
}

interface OrganizationSession {
  session_id: string;
  algorithm: ClusteringAlgorithm;
  num_clusters: number;
  min_files: number;
  preview_only: boolean;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  created_at: string;
  completed_at?: string;
}

interface GetClustersOptions {
  includeApplied?: boolean | undefined;
  algorithm?: ClusteringAlgorithm | null | undefined;
}

interface Cluster {
  id: string;
  cluster_index: number;
  suggested_folder_name: string;
  file_count: number;
  total_size_mb: number;
  representative_files: string[];
  common_extensions: string[];
  algorithm: ClusteringAlgorithm;
  confidence_score: number;
  is_applied: boolean;
  is_dismissed: boolean;
  created_at: string;
}

interface ApplyClusterRequest {
  target_folder_path: string | null;
}

interface ApplyClusterResponse {
  success: boolean;
  folder_path: string;
  files_moved: number;
  cluster_id: string;
}

interface OrganizationRule {
  id: string;
  rule_name: string;
  rule_type: RuleType;
  target_folder_path: string;
  pattern?: string;
  file_extensions?: string[];
  keywords?: string[];
  date_field?: 'created' | 'modified' | 'accessed';
  date_range_days?: number;
  create_subfolder_by_date?: boolean;
  auto_apply: boolean;
  is_active: boolean;
  priority: number;
  created_at: string;
  last_applied_at?: string;
}

interface CreateRuleInput {
  ruleName: string;
  ruleType: RuleType;
  targetFolderPath: string;
  pattern?: string | undefined;
  fileExtensions?: string[] | undefined;
  keywords?: string[] | undefined;
  dateField?: 'created' | 'modified' | 'accessed' | undefined;
  dateRangeDays?: number | undefined;
  createSubfolderByDate?: boolean | undefined;
  autoApply?: boolean | undefined;
  priority?: number | undefined;
}

interface CreateRuleRequest {
  rule_name: string;
  rule_type: RuleType;
  target_folder_path: string;
  pattern?: string | undefined;
  file_extensions?: string[] | undefined;
  keywords?: string[] | undefined;
  date_field?: 'created' | 'modified' | 'accessed' | undefined;
  date_range_days?: number | undefined;
  create_subfolder_by_date?: boolean | undefined;
  auto_apply?: boolean | undefined;
  priority?: number | undefined;
}

interface UpdateRuleInput {
  isActive?: boolean | undefined;
  autoApply?: boolean | undefined;
  priority?: number | undefined;
  targetFolderPath?: string | undefined;
}

interface UpdateRuleRequest {
  is_active?: boolean | undefined;
  auto_apply?: boolean | undefined;
  priority?: number | undefined;
  target_folder_path?: string | undefined;
}

interface ApplyRulesResponse {
  success: boolean;
  rules_applied: number;
  files_organized: number;
  folders_created: number;
}

interface ErrorResponse {
  detail?: string;
}

// ==================== Organization Service Class ====================

class OrganizationService {
  // ==================== ML Clustering ====================

  /**
   * Start ML-based organization analysis
   * @param params - Organization parameters
   * @returns Organization session result
   */
  async startOrganization(params: StartOrganizationParams = {}): Promise<OrganizationSession> {
    const { algorithm = 'kmeans', numClusters = 5, minFiles = 3, previewOnly = true } = params;

    const requestBody: StartOrganizationRequest = {
      algorithm,
      num_clusters: numClusters,
      min_files: minFiles,
      preview_only: previewOnly,
    };

    const response = await fetch(`${API_URL}/api/v1/organization/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as ErrorResponse;
      throw new Error(error.detail || `Failed to start organization: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Get organization clusters
   * @param options - Query options
   * @returns List of clusters
   */
  async getClusters(options: GetClustersOptions = {}): Promise<Cluster[]> {
    const { includeApplied = false, algorithm = null } = options;

    const params = new URLSearchParams();
    if (includeApplied) params.append('include_applied', 'true');
    if (algorithm) params.append('algorithm', algorithm);

    const response = await fetch(`${API_URL}/api/v1/organization/clusters?${params}`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch clusters: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Apply cluster organization
   * @param clusterId - Cluster ID
   * @param targetFolderPath - Optional custom target path
   * @returns Application result
   */
  async applyCluster(
    clusterId: string,
    targetFolderPath: string | null = null
  ): Promise<ApplyClusterResponse> {
    const requestBody: ApplyClusterRequest = {
      target_folder_path: targetFolderPath,
    };

    const response = await fetch(`${API_URL}/api/v1/organization/clusters/${clusterId}/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as ErrorResponse;
      throw new Error(error.detail || `Failed to apply cluster: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Dismiss cluster suggestion
   * @param clusterId - Cluster ID
   * @returns Result
   */
  async dismissCluster(clusterId: string): Promise<{ success: boolean }> {
    const response = await fetch(`${API_URL}/api/v1/organization/clusters/${clusterId}/dismiss`, {
      method: 'POST',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to dismiss cluster: ${response.status}`);
    }

    return await response.json();
  }

  // ==================== Organization Rules ====================

  /**
   * Get organization rules
   * @param includeInactive - Include inactive rules
   * @returns List of rules
   */
  async getRules(includeInactive: boolean = false): Promise<OrganizationRule[]> {
    const params = new URLSearchParams();
    if (includeInactive) params.append('include_inactive', 'true');

    const response = await fetch(`${API_URL}/api/v1/organization/rules?${params}`, {
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch rules: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Create organization rule
   * @param rule - Rule parameters
   * @returns Created rule
   */
  async createRule(rule: CreateRuleInput): Promise<OrganizationRule> {
    const requestBody: CreateRuleRequest = {
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
      priority: rule.priority,
    };

    const response = await fetch(`${API_URL}/api/v1/organization/rules`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const error = (await response.json().catch(() => ({}))) as ErrorResponse;
      throw new Error(error.detail || `Failed to create rule: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Update organization rule
   * @param ruleId - Rule ID
   * @param updates - Update parameters
   * @returns Updated rule
   */
  async updateRule(ruleId: string, updates: UpdateRuleInput): Promise<OrganizationRule> {
    const requestBody: UpdateRuleRequest = {
      is_active: updates.isActive,
      auto_apply: updates.autoApply,
      priority: updates.priority,
      target_folder_path: updates.targetFolderPath,
    };

    const response = await fetch(`${API_URL}/api/v1/organization/rules/${ruleId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      throw new Error(`Failed to update rule: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Delete organization rule
   * @param ruleId - Rule ID
   * @returns Result
   */
  async deleteRule(ruleId: string): Promise<{ success: boolean }> {
    const response = await fetch(`${API_URL}/api/v1/organization/rules/${ruleId}`, {
      method: 'DELETE',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to delete rule: ${response.status}`);
    }

    return await response.json();
  }

  /**
   * Apply all active rules
   * @returns Application result
   */
  async applyRules(): Promise<ApplyRulesResponse> {
    const response = await fetch(`${API_URL}/api/v1/organization/rules/apply`, {
      method: 'POST',
      credentials: 'include',
    });

    if (!response.ok) {
      throw new Error(`Failed to apply rules: ${response.status}`);
    }

    return await response.json();
  }
}

export const organizationService = new OrganizationService();
export default organizationService;
