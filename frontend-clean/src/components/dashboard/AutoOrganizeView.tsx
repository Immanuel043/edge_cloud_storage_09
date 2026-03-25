import React, { useState, useEffect, useCallback } from 'react';
import {
  FolderCog,
  Loader,
  AlertCircle,
  FolderPlus,
  X,
  Check,
  FileText,
  Image,
  Video,
  Music,
  Archive,
  Code,
  File,
  Play,
  Settings,
  Plus,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Brain,
  Layers,
  ChevronDown,
  ChevronRight,
} from 'lucide-react';
import { organizationService } from '../../services/organizationService';
import { API_URL } from '../../config/constants';
import { formatBytes } from '../../utils/helpers';
import type { AutoOrganizeViewProps, OrganizationCluster, OrganizationRule } from './types';
import { getErrorMessage } from './types';

type TabType = 'clusters' | 'rules';
type RuleType = 'extension' | 'keyword' | 'date' | 'size';

interface NewRule {
  ruleName: string;
  ruleType: RuleType;
  targetFolderPath: string;
  fileExtensions: string[];
  keywords: string[];
  autoApply: boolean;
  priority: number;
}

/**
 * AutoOrganizeView - ML-powered file organization suggestions
 */
const AutoOrganizeView: React.FC<AutoOrganizeViewProps> = ({ darkMode }) => {
  const [clusters, setClusters] = useState<OrganizationCluster[]>([]);
  const [rules, setRules] = useState<OrganizationRule[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [analyzing, setAnalyzing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('clusters');
  const [showCreateRule, setShowCreateRule] = useState<boolean>(false);
  const [newRule, setNewRule] = useState<NewRule>({
    ruleName: '',
    ruleType: 'extension',
    targetFolderPath: '',
    fileExtensions: [],
    keywords: [],
    autoApply: false,
    priority: 1
  });
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());
  const [clusterFiles, setClusterFiles] = useState<Record<string, { name: string; mime_type?: string; size?: number; confidence?: number }[]>>({});
  const [loadingClusterFiles, setLoadingClusterFiles] = useState<Set<string>>(new Set());

  const toggleClusterExpand = useCallback(async (clusterId: string) => {
    setExpandedClusters(prev => {
      const next = new Set(prev);
      if (next.has(clusterId)) {
        next.delete(clusterId);
      } else {
        next.add(clusterId);
      }
      return next;
    });

    // Lazy load files if not already loaded
    if (!clusterFiles[clusterId] && !loadingClusterFiles.has(clusterId)) {
      setLoadingClusterFiles(prev => new Set(prev).add(clusterId));
      try {
        const res = await fetch(`${API_URL}/api/v1/organization/clusters/${clusterId}/files?limit=20`, {
          credentials: 'include',
        });
        if (res.ok) {
          const data = await res.json();
          setClusterFiles(prev => ({ ...prev, [clusterId]: data.files || [] }));
        }
      } catch {
        // Ignore
      } finally {
        setLoadingClusterFiles(prev => {
          const next = new Set(prev);
          next.delete(clusterId);
          return next;
        });
      }
    }
  }, [clusterFiles, loadingClusterFiles]);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async (): Promise<void> => {
    try {
      setLoading(true);
      setError(null);

      const [clustersData, rulesData] = await Promise.all([
        organizationService.getClusters().catch(() => []),
        organizationService.getRules().catch(() => [])
      ]);

      setClusters(clustersData as OrganizationCluster[]);
      setRules(rulesData as OrganizationRule[]);
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('[AutoOrganize] Failed to load:', err);
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleStartAnalysis = async (): Promise<void> => {
    try {
      setAnalyzing(true);
      setError(null);

      await organizationService.startOrganization({
        algorithm: 'kmeans',
        numClusters: 5,
        minFiles: 3,
        previewOnly: true
      });

      // Reload clusters
      const clustersData = await organizationService.getClusters();
      setClusters((clustersData as unknown) as OrganizationCluster[]);
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('[AutoOrganize] Analysis failed:', err);
      setError(errorMessage);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleApplyCluster = async (clusterId: string): Promise<void> => {
    try {
      await organizationService.applyCluster(clusterId);
      // Refresh clusters
      const clustersData = await organizationService.getClusters();
      setClusters((clustersData as unknown) as OrganizationCluster[]);
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('[AutoOrganize] Apply failed:', err);
      setError(errorMessage);
    }
  };

  const handleDismissCluster = async (clusterId: string): Promise<void> => {
    try {
      await organizationService.dismissCluster(clusterId);
      setClusters(prev => prev.filter(c => c.id !== clusterId));
    } catch (err: unknown) {
      console.error('[AutoOrganize] Dismiss failed:', err);
    }
  };

  const handleCreateRule = async (): Promise<void> => {
    try {
      await organizationService.createRule(newRule as unknown as Parameters<typeof organizationService.createRule>[0]);
      setShowCreateRule(false);
      setNewRule({
        ruleName: '',
        ruleType: 'extension',
        targetFolderPath: '',
        fileExtensions: [],
        keywords: [],
        autoApply: false,
        priority: 1
      });
      // Refresh rules
      const rulesData = await organizationService.getRules();
      setRules((rulesData as unknown) as OrganizationRule[]);
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('[AutoOrganize] Create rule failed:', err);
      setError(errorMessage);
    }
  };

  const handleToggleRule = async (ruleId: string, isActive: boolean): Promise<void> => {
    try {
      await organizationService.updateRule(ruleId, { isActive: !isActive });
      setRules(prev => prev.map(r => r.id === ruleId ? { ...r, is_active: !isActive } : r));
    } catch (err: unknown) {
      console.error('[AutoOrganize] Toggle rule failed:', err);
    }
  };

  const handleDeleteRule = async (ruleId: string): Promise<void> => {
    try {
      await organizationService.deleteRule(ruleId);
      setRules(prev => prev.filter(r => r.id !== ruleId));
    } catch (err: unknown) {
      console.error('[AutoOrganize] Delete rule failed:', err);
    }
  };

  const handleApplyAllRules = async (): Promise<void> => {
    try {
      setAnalyzing(true);
      const result = await organizationService.applyRules() as { rules_applied?: number; files_organized?: number };
      // TODO: Replace alert() with toast notification
      alert(`Applied ${result.rules_applied || 0} rules, organized ${result.files_organized || 0} files`);
      await loadData();
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('[AutoOrganize] Apply rules failed:', err);
      setError(errorMessage);
    } finally {
      setAnalyzing(false);
    }
  };

  const getFileIcon = (extensions?: string[]): React.ReactElement => {
    if (!extensions || extensions.length === 0) return <File size={16} />;
    const ext = extensions[0]?.toLowerCase() || '';
    if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext)) return <Image size={16} className="text-purple-500" />;
    if (['mp4', 'avi', 'mkv', 'mov', 'webm'].includes(ext)) return <Video size={16} className="text-red-500" />;
    if (['mp3', 'wav', 'flac', 'aac'].includes(ext)) return <Music size={16} className="text-green-500" />;
    if (['pdf', 'doc', 'docx', 'txt'].includes(ext)) return <FileText size={16} className="text-blue-500" />;
    if (['zip', 'rar', '7z', 'tar'].includes(ext)) return <Archive size={16} className="text-yellow-500" />;
    if (['js', 'jsx', 'ts', 'py', 'java'].includes(ext)) return <Code size={16} className="text-orange-500" />;
    return <File size={16} />;
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-4">
        <Loader className="animate-spin text-blue-500" size={48} />
        <p className={`${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          Loading organization data...
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`p-3 rounded-xl ${darkMode ? 'bg-purple-900/30' : 'bg-purple-100'}`}>
            <FolderCog className="text-purple-500" size={28} />
          </div>
          <div>
            <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Auto-Organize
            </h1>
            <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              ML-powered file organization suggestions
            </p>
          </div>
        </div>
        <button
          onClick={handleStartAnalysis}
          disabled={analyzing}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
            analyzing
              ? 'bg-gray-400 cursor-not-allowed'
              : 'bg-purple-600 hover:bg-purple-700 text-white'
          }`}
          type="button"
        >
          {analyzing ? (
            <>
              <Loader className="animate-spin" size={18} />
              Analyzing...
            </>
          ) : (
            <>
              <Brain size={18} />
              Run ML Analysis
            </>
          )}
        </button>
      </div>

      {/* Error Message */}
      {error && (
        <div className={`rounded-lg p-4 ${darkMode ? 'bg-red-900/30' : 'bg-red-50'} border ${darkMode ? 'border-red-800' : 'border-red-200'}`}>
          <div className="flex items-center gap-2 text-red-500">
            <AlertCircle size={20} />
            <span>{error}</span>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className={`flex gap-2 p-1 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-gray-100'}`}>
        <button
          onClick={() => setActiveTab('clusters')}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md transition-all ${
            activeTab === 'clusters'
              ? darkMode ? 'bg-purple-600 text-white' : 'bg-white text-purple-600 shadow'
              : darkMode ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-900'
          }`}
          type="button"
        >
          <Layers size={18} />
          ML Clusters ({clusters.length})
        </button>
        <button
          onClick={() => setActiveTab('rules')}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md transition-all ${
            activeTab === 'rules'
              ? darkMode ? 'bg-purple-600 text-white' : 'bg-white text-purple-600 shadow'
              : darkMode ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-900'
          }`}
          type="button"
        >
          <Settings size={18} />
          Rules ({rules.length})
        </button>
      </div>

      {/* Clusters Tab */}
      {activeTab === 'clusters' && (
        <div className="space-y-4">
          {clusters.length === 0 ? (
            <div className={`rounded-lg p-8 text-center ${darkMode ? 'bg-gray-800' : 'bg-white'} border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
              <Brain className={`mx-auto mb-4 ${darkMode ? 'text-gray-600' : 'text-gray-400'}`} size={48} />
              <h3 className={`text-lg font-medium mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                No Clusters Found
              </h3>
              <p className={`mb-4 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                Run ML analysis to discover file organization patterns
              </p>
              <button
                onClick={handleStartAnalysis}
                disabled={analyzing}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium"
                type="button"
              >
                Start Analysis
              </button>
            </div>
          ) : (
            <div className="grid gap-4">
              {clusters.map((cluster) => (
                <div
                  key={cluster.id}
                  className={`rounded-lg p-4 ${darkMode ? 'bg-gray-800' : 'bg-white'} border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3">
                      <div className={`p-2 rounded-lg ${darkMode ? 'bg-purple-900/30' : 'bg-purple-100'}`}>
                        {getFileIcon(cluster.common_extensions)}
                      </div>
                      <div>
                        <h3 className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                          {cluster.cluster_name || `Cluster ${cluster.cluster_id || cluster.id}`}
                        </h3>
                        <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                          {cluster.cluster_description || 'No description'}
                        </p>
                        <div className="flex flex-wrap gap-2 mt-2">
                          <span className={`text-xs px-2 py-1 rounded ${darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-700'}`}>
                            {cluster.num_files} files
                          </span>
                          <span className={`text-xs px-2 py-1 rounded ${darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-700'}`}>
                            {formatBytes(cluster.total_size)}
                          </span>
                          {cluster.common_extensions?.slice(0, 3).map((ext, i) => (
                            <span key={i} className={`text-xs px-2 py-1 rounded ${darkMode ? 'bg-blue-900/30 text-blue-400' : 'bg-blue-100 text-blue-700'}`}>
                              .{ext}
                            </span>
                          ))}
                        </div>
                        {cluster.top_keywords && cluster.top_keywords.length > 0 && (
                          <div className="flex flex-wrap gap-1 mt-2">
                            {cluster.top_keywords.slice(0, 5).map((kw, i) => (
                              <span key={i} className={`text-xs px-2 py-0.5 rounded-full ${darkMode ? 'bg-purple-900/30 text-purple-400' : 'bg-purple-100 text-purple-700'}`}>
                                {kw}
                              </span>
                            ))}
                          </div>
                        )}
                        {cluster.suggested_folder_path && (
                          <div className={`flex items-center gap-1 mt-2 text-sm ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                            <FolderPlus size={14} />
                            <span>Suggested: {cluster.suggested_folder_path}</span>
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => toggleClusterExpand(cluster.id)}
                        className={`p-1.5 rounded-lg ${darkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-600'}`}
                        type="button"
                        title="Preview files"
                      >
                        {expandedClusters.has(cluster.id) ? <ChevronDown size={18} /> : <ChevronRight size={18} />}
                      </button>
                      <button
                        onClick={() => handleApplyCluster(cluster.id)}
                        className="flex items-center gap-1 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium"
                        type="button"
                      >
                        <Check size={14} />
                        Apply
                      </button>
                      <button
                        onClick={() => handleDismissCluster(cluster.id)}
                        className={`p-1.5 rounded-lg ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                        type="button"
                      >
                        <X size={18} className={darkMode ? 'text-gray-400' : 'text-gray-600'} />
                      </button>
                    </div>
                  </div>

                  {/* Expanded file list */}
                  {expandedClusters.has(cluster.id) && (
                    <div className={`mt-3 pt-3 border-t ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                      {loadingClusterFiles.has(cluster.id) ? (
                        <div className="flex items-center gap-2 py-2">
                          <Loader className="animate-spin" size={14} />
                          <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Loading files...</span>
                        </div>
                      ) : (clusterFiles[cluster.id] ?? []).length > 0 ? (
                        <div className="space-y-1">
                          {(clusterFiles[cluster.id] ?? []).map((f, idx) => (
                            <div
                              key={idx}
                              className={`flex items-center gap-2 px-2 py-1 rounded text-sm ${
                                darkMode ? 'text-gray-300 hover:bg-gray-700/50' : 'text-gray-700 hover:bg-gray-50'
                              }`}
                            >
                              {getFileIcon(f.mime_type ? [f.mime_type.split('/').pop() || ''] : undefined)}
                              <span className="flex-1 truncate">{f.name}</span>
                              {f.size != null && (
                                <span className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                                  {formatBytes(f.size)}
                                </span>
                              )}
                              {f.confidence != null && (
                                <span className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                                  {(f.confidence * 100).toFixed(0)}%
                                </span>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className={`text-sm py-2 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                          No files found in this cluster.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Rules Tab */}
      {activeTab === 'rules' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Create rules to automatically organize files based on patterns
            </p>
            <div className="flex gap-2">
              {rules.length > 0 && (
                <button
                  onClick={handleApplyAllRules}
                  disabled={analyzing}
                  className="flex items-center gap-2 px-3 py-1.5 bg-green-600 hover:bg-green-700 text-white rounded-lg text-sm font-medium"
                  type="button"
                >
                  <Play size={14} />
                  Apply All Rules
                </button>
              )}
              <button
                onClick={() => setShowCreateRule(true)}
                className="flex items-center gap-2 px-3 py-1.5 bg-purple-600 hover:bg-purple-700 text-white rounded-lg text-sm font-medium"
                type="button"
              >
                <Plus size={14} />
                Create Rule
              </button>
            </div>
          </div>

          {rules.length === 0 ? (
            <div className={`rounded-lg p-8 text-center ${darkMode ? 'bg-gray-800' : 'bg-white'} border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
              <Settings className={`mx-auto mb-4 ${darkMode ? 'text-gray-600' : 'text-gray-400'}`} size={48} />
              <h3 className={`text-lg font-medium mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                No Rules Created
              </h3>
              <p className={`mb-4 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                Create rules to automatically organize your files
              </p>
              <button
                onClick={() => setShowCreateRule(true)}
                className="px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium"
                type="button"
              >
                Create First Rule
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {rules.map((rule) => (
                <div
                  key={rule.id}
                  className={`rounded-lg p-4 ${darkMode ? 'bg-gray-800' : 'bg-white'} border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <button
                        onClick={() => handleToggleRule(rule.id, rule.is_active || false)}
                        className={`p-1 rounded ${rule.is_active ? 'text-green-500' : darkMode ? 'text-gray-600' : 'text-gray-400'}`}
                        type="button"
                      >
                        {rule.is_active ? <ToggleRight size={24} /> : <ToggleLeft size={24} />}
                      </button>
                      <div>
                        <h3 className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                          {rule.rule_name}
                        </h3>
                        <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                          {rule.rule_type} → {rule.target_folder_path}
                        </p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`text-xs px-2 py-0.5 rounded ${darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-700'}`}>
                            {rule.files_organized || 0} files organized
                          </span>
                          {rule.auto_apply && (
                            <span className={`text-xs px-2 py-0.5 rounded ${darkMode ? 'bg-green-900/30 text-green-400' : 'bg-green-100 text-green-700'}`}>
                              Auto-apply
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <button
                      onClick={() => handleDeleteRule(rule.id)}
                      className={`p-2 rounded-lg ${darkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-600'}`}
                      type="button"
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Create Rule Modal */}
      {showCreateRule && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className={`w-full max-w-md rounded-xl p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            <div className="flex items-center justify-between mb-4">
              <h2 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Create Organization Rule
              </h2>
              <button onClick={() => setShowCreateRule(false)} type="button">
                <X size={20} className={darkMode ? 'text-gray-400' : 'text-gray-600'} />
              </button>
            </div>
            <div className="space-y-4">
              <div>
                <label className={`block text-sm font-medium mb-1 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                  Rule Name
                </label>
                <input
                  type="text"
                  value={newRule.ruleName}
                  onChange={(e) => setNewRule({ ...newRule, ruleName: e.target.value })}
                  className={`w-full px-3 py-2 rounded-lg border ${darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300'}`}
                  placeholder="e.g., Images to Photos folder"
                />
              </div>
              <div>
                <label className={`block text-sm font-medium mb-1 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                  Rule Type
                </label>
                <select
                  value={newRule.ruleType}
                  onChange={(e) => setNewRule({ ...newRule, ruleType: e.target.value as RuleType })}
                  className={`w-full px-3 py-2 rounded-lg border ${darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300'}`}
                >
                  <option value="extension">By Extension</option>
                  <option value="keyword">By Keyword</option>
                  <option value="date">By Date</option>
                  <option value="size">By Size</option>
                </select>
              </div>
              <div>
                <label className={`block text-sm font-medium mb-1 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                  Target Folder
                </label>
                <input
                  type="text"
                  value={newRule.targetFolderPath}
                  onChange={(e) => setNewRule({ ...newRule, targetFolderPath: e.target.value })}
                  className={`w-full px-3 py-2 rounded-lg border ${darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300'}`}
                  placeholder="/Photos"
                />
              </div>
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  id="autoApply"
                  checked={newRule.autoApply}
                  onChange={(e) => setNewRule({ ...newRule, autoApply: e.target.checked })}
                  className="rounded"
                />
                <label htmlFor="autoApply" className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                  Auto-apply to new uploads
                </label>
              </div>
              <div className="flex gap-2 pt-4">
                <button
                  onClick={() => setShowCreateRule(false)}
                  className={`flex-1 px-4 py-2 rounded-lg border ${darkMode ? 'border-gray-600 text-gray-300 hover:bg-gray-700' : 'border-gray-300 text-gray-700 hover:bg-gray-50'}`}
                  type="button"
                >
                  Cancel
                </button>
                <button
                  onClick={handleCreateRule}
                  disabled={!newRule.ruleName || !newRule.targetFolderPath}
                  className="flex-1 px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-700 text-white disabled:bg-gray-400"
                  type="button"
                >
                  Create Rule
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AutoOrganizeView;
