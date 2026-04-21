import React, { useState, useEffect, useCallback } from 'react';
import {
  FolderCog,
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
  Brain,
  Layers,
  ChevronDown,
  ChevronRight,
  AlertCircle,
} from 'lucide-react';
import { organizationService } from '../../services/organizationService';
import { API_URL } from '../../config/constants';
import { formatBytes } from '../../utils/helpers';
import type {
  AutoOrganizeViewProps,
  OrganizationCluster,
  OrganizationRule,
} from './types';
import { getErrorMessage } from './types';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  Checkbox,
  EmptyState,
  FormField,
  IconButton,
  Input,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Select,
  Spinner,
  Switch,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui';

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
 * AutoOrganizeView — ML-powered file organization suggestions. Two tabs:
 * "ML Clusters" shows KMeans-discovered file groups with apply/dismiss
 * actions and expandable file previews; "Rules" lets users define
 * extension/keyword/date/size-based auto-organization rules.
 */
const AutoOrganizeView: React.FC<AutoOrganizeViewProps> = () => {
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
    priority: 1,
  });
  const [expandedClusters, setExpandedClusters] = useState<Set<string>>(new Set());
  const [clusterFiles, setClusterFiles] = useState<
    Record<string, { name: string; mime_type?: string; size?: number; confidence?: number }[]>
  >({});
  const [loadingClusterFiles, setLoadingClusterFiles] = useState<Set<string>>(new Set());

  const toggleClusterExpand = useCallback(
    async (clusterId: string) => {
      setExpandedClusters((prev) => {
        const next = new Set(prev);
        if (next.has(clusterId)) next.delete(clusterId);
        else next.add(clusterId);
        return next;
      });

      if (!clusterFiles[clusterId] && !loadingClusterFiles.has(clusterId)) {
        setLoadingClusterFiles((prev) => new Set(prev).add(clusterId));
        try {
          const res = await fetch(
            `${API_URL}/api/v1/organization/clusters/${clusterId}/files?limit=20`,
            { credentials: 'include' }
          );
          if (res.ok) {
            const data = await res.json();
            setClusterFiles((prev) => ({ ...prev, [clusterId]: data.files || [] }));
          }
        } catch {
          // Ignore
        } finally {
          setLoadingClusterFiles((prev) => {
            const next = new Set(prev);
            next.delete(clusterId);
            return next;
          });
        }
      }
    },
    [clusterFiles, loadingClusterFiles]
  );

  useEffect(() => {
    void loadData();
  }, []);

  const loadData = async (): Promise<void> => {
    try {
      setLoading(true);
      setError(null);
      const [clustersData, rulesData] = await Promise.all([
        organizationService.getClusters().catch(() => []),
        organizationService.getRules().catch(() => []),
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
        previewOnly: true,
      });
      const clustersData = await organizationService.getClusters();
      setClusters(clustersData as unknown as OrganizationCluster[]);
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
      const clustersData = await organizationService.getClusters();
      setClusters(clustersData as unknown as OrganizationCluster[]);
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('[AutoOrganize] Apply failed:', err);
      setError(errorMessage);
    }
  };

  const handleDismissCluster = async (clusterId: string): Promise<void> => {
    try {
      await organizationService.dismissCluster(clusterId);
      setClusters((prev) => prev.filter((c) => c.id !== clusterId));
    } catch (err: unknown) {
      console.error('[AutoOrganize] Dismiss failed:', err);
    }
  };

  const handleCreateRule = async (): Promise<void> => {
    try {
      await organizationService.createRule(
        newRule as unknown as Parameters<typeof organizationService.createRule>[0]
      );
      setShowCreateRule(false);
      setNewRule({
        ruleName: '',
        ruleType: 'extension',
        targetFolderPath: '',
        fileExtensions: [],
        keywords: [],
        autoApply: false,
        priority: 1,
      });
      const rulesData = await organizationService.getRules();
      setRules(rulesData as unknown as OrganizationRule[]);
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('[AutoOrganize] Create rule failed:', err);
      setError(errorMessage);
    }
  };

  const handleToggleRule = async (ruleId: string, isActive: boolean): Promise<void> => {
    try {
      await organizationService.updateRule(ruleId, { isActive: !isActive });
      setRules((prev) =>
        prev.map((r) => (r.id === ruleId ? { ...r, is_active: !isActive } : r))
      );
    } catch (err: unknown) {
      console.error('[AutoOrganize] Toggle rule failed:', err);
    }
  };

  const handleDeleteRule = async (ruleId: string): Promise<void> => {
    try {
      await organizationService.deleteRule(ruleId);
      setRules((prev) => prev.filter((r) => r.id !== ruleId));
    } catch (err: unknown) {
      console.error('[AutoOrganize] Delete rule failed:', err);
    }
  };

  const handleApplyAllRules = async (): Promise<void> => {
    try {
      setAnalyzing(true);
      const result = (await organizationService.applyRules()) as {
        rules_applied?: number;
        files_organized?: number;
      };
      alert(
        `Applied ${result.rules_applied || 0} rules, organized ${result.files_organized || 0} files`
      );
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
    if (!extensions || extensions.length === 0) return <File className="h-4 w-4" />;
    const ext = extensions[0]?.toLowerCase() || '';
    if (['jpg', 'jpeg', 'png', 'gif', 'svg', 'webp'].includes(ext))
      return <Image className="h-4 w-4 text-accent" />;
    if (['mp4', 'avi', 'mkv', 'mov', 'webm'].includes(ext))
      return <Video className="h-4 w-4 text-danger" />;
    if (['mp3', 'wav', 'flac', 'aac'].includes(ext))
      return <Music className="h-4 w-4 text-success" />;
    if (['pdf', 'doc', 'docx', 'txt'].includes(ext))
      return <FileText className="h-4 w-4 text-primary" />;
    if (['zip', 'rar', '7z', 'tar'].includes(ext))
      return <Archive className="h-4 w-4 text-warning" />;
    if (['js', 'jsx', 'ts', 'py', 'java'].includes(ext))
      return <Code className="h-4 w-4 text-accent" />;
    return <File className="h-4 w-4" />;
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-accent/10 text-accent">
            <FolderCog className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-h2 font-bold text-fg">Auto-organize</h1>
            <p className="text-body-sm text-fg-muted">
              ML-powered file organization suggestions
            </p>
          </div>
        </div>
        <Button
          variant="primary"
          size="md"
          onClick={() => void handleStartAnalysis()}
          disabled={analyzing}
          loading={analyzing}
          leftIcon={!analyzing ? <Brain className="h-4 w-4" /> : undefined}
        >
          {analyzing ? 'Analyzing...' : 'Run ML analysis'}
        </Button>
      </div>

      {/* Error */}
      {error && (
        <Banner
          variant="danger"
          icon={<AlertCircle />}
          onDismiss={() => setError(null)}
        >
          {error}
        </Banner>
      )}

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onChange={(v) => setActiveTab(v as TabType)}
        variant="pill"
      >
        <TabsList className="w-full">
          <TabsTrigger value="clusters" className="flex-1 justify-center gap-2">
            <Layers className="h-4 w-4" />
            ML clusters ({clusters.length})
          </TabsTrigger>
          <TabsTrigger value="rules" className="flex-1 justify-center gap-2">
            <Settings className="h-4 w-4" />
            Rules ({rules.length})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Clusters Tab */}
      {activeTab === 'clusters' && (
        <div className="space-y-4">
          {clusters.length === 0 ? (
            <Card variant="bordered">
              <CardContent className="p-6">
                <EmptyState
                  icon={<Brain />}
                  title="No clusters found"
                  description="Run ML analysis to discover file organization patterns."
                  action={
                    <Button
                      variant="primary"
                      onClick={() => void handleStartAnalysis()}
                      disabled={analyzing}
                      loading={analyzing}
                    >
                      Start analysis
                    </Button>
                  }
                  size="lg"
                />
              </CardContent>
            </Card>
          ) : (
            <div className="grid gap-4">
              {clusters.map((cluster) => (
                <Card key={cluster.id} variant="bordered">
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="flex items-start gap-3">
                        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-accent/10">
                          {getFileIcon(cluster.common_extensions)}
                        </div>
                        <div className="min-w-0">
                          <h3 className="text-body font-semibold text-fg">
                            {cluster.cluster_name ||
                              `Cluster ${cluster.cluster_id || cluster.id}`}
                          </h3>
                          <p className="text-body-sm text-fg-muted">
                            {cluster.cluster_description || 'No description'}
                          </p>
                          <div className="mt-2 flex flex-wrap items-center gap-2">
                            <Badge variant="neutral" size="sm">
                              {cluster.num_files} files
                            </Badge>
                            <Badge variant="neutral" size="sm">
                              {formatBytes(cluster.total_size)}
                            </Badge>
                            {cluster.common_extensions?.slice(0, 3).map((ext, i) => (
                              <Badge key={i} variant="info" size="sm">
                                .{ext}
                              </Badge>
                            ))}
                          </div>
                          {cluster.top_keywords && cluster.top_keywords.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {cluster.top_keywords.slice(0, 5).map((kw, i) => (
                                <Badge key={i} variant="info" size="sm">
                                  {kw}
                                </Badge>
                              ))}
                            </div>
                          )}
                          {cluster.suggested_folder_path && (
                            <div className="mt-2 flex items-center gap-1 text-body-sm text-fg-muted">
                              <FolderPlus className="h-3.5 w-3.5" />
                              <span>Suggested: {cluster.suggested_folder_path}</span>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <IconButton
                          variant="ghost"
                          size="sm"
                          aria-label="Preview files"
                          onClick={() => void toggleClusterExpand(cluster.id)}
                        >
                          {expandedClusters.has(cluster.id) ? (
                            <ChevronDown className="h-4 w-4" />
                          ) : (
                            <ChevronRight className="h-4 w-4" />
                          )}
                        </IconButton>
                        <Button
                          variant="primary"
                          size="sm"
                          leftIcon={<Check className="h-3.5 w-3.5" />}
                          onClick={() => void handleApplyCluster(cluster.id)}
                        >
                          Apply
                        </Button>
                        <IconButton
                          variant="ghost"
                          size="sm"
                          aria-label="Dismiss cluster"
                          onClick={() => void handleDismissCluster(cluster.id)}
                        >
                          <X className="h-4 w-4" />
                        </IconButton>
                      </div>
                    </div>

                    {/* Expanded file list */}
                    {expandedClusters.has(cluster.id) && (
                      <div className="mt-3 border-t border-border pt-3">
                        {loadingClusterFiles.has(cluster.id) ? (
                          <div className="flex items-center gap-2 py-2">
                            <Spinner size="sm" />
                            <span className="text-body-sm text-fg-muted">Loading files...</span>
                          </div>
                        ) : (clusterFiles[cluster.id] ?? []).length > 0 ? (
                          <div className="space-y-1">
                            {(clusterFiles[cluster.id] ?? []).map((f, idx) => (
                              <div
                                key={idx}
                                className="flex items-center gap-2 rounded px-2 py-1 text-body-sm text-fg hover:bg-surface-muted"
                              >
                                {getFileIcon(
                                  f.mime_type
                                    ? [f.mime_type.split('/').pop() || '']
                                    : undefined
                                )}
                                <span className="flex-1 truncate">{f.name}</span>
                                {f.size != null && (
                                  <span className="text-caption text-fg-muted">
                                    {formatBytes(f.size)}
                                  </span>
                                )}
                                {f.confidence != null && (
                                  <span className="text-caption text-fg-muted">
                                    {(f.confidence * 100).toFixed(0)}%
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <p className="py-2 text-body-sm text-fg-muted">
                            No files found in this cluster.
                          </p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Rules Tab */}
      {activeTab === 'rules' && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-body-sm text-fg-muted">
              Create rules to automatically organize files based on patterns.
            </p>
            <div className="flex gap-2">
              {rules.length > 0 && (
                <Button
                  variant="primary"
                  size="sm"
                  leftIcon={<Play className="h-3.5 w-3.5" />}
                  onClick={() => void handleApplyAllRules()}
                  disabled={analyzing}
                  loading={analyzing}
                >
                  Apply all rules
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                leftIcon={<Plus className="h-3.5 w-3.5" />}
                onClick={() => setShowCreateRule(true)}
              >
                Create rule
              </Button>
            </div>
          </div>

          {rules.length === 0 ? (
            <Card variant="bordered">
              <CardContent className="p-6">
                <EmptyState
                  icon={<Settings />}
                  title="No rules created"
                  description="Create rules to automatically organize your files."
                  action={
                    <Button variant="primary" onClick={() => setShowCreateRule(true)}>
                      Create first rule
                    </Button>
                  }
                  size="lg"
                />
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-3">
              {rules.map((rule) => (
                <Card key={rule.id} variant="bordered">
                  <CardContent className="p-4">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <Switch
                          checked={rule.is_active || false}
                          onChange={() =>
                            void handleToggleRule(rule.id, rule.is_active || false)
                          }
                          aria-label={`Toggle rule ${rule.rule_name}`}
                        />
                        <div>
                          <h3 className="text-body font-medium text-fg">{rule.rule_name}</h3>
                          <p className="text-body-sm text-fg-muted">
                            {rule.rule_type} → {rule.target_folder_path}
                          </p>
                          <div className="mt-1 flex flex-wrap items-center gap-2">
                            <Badge variant="neutral" size="sm">
                              {rule.files_organized || 0} files organized
                            </Badge>
                            {rule.auto_apply && (
                              <Badge variant="success" size="sm">
                                Auto-apply
                              </Badge>
                            )}
                          </div>
                        </div>
                      </div>
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label="Delete rule"
                        onClick={() => void handleDeleteRule(rule.id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Create Rule Modal */}
      <Modal open={showCreateRule} onClose={() => setShowCreateRule(false)} size="md">
        <ModalHeader>Create organization rule</ModalHeader>
        <ModalBody>
          <div className="space-y-4">
            <FormField label="Rule name">
              <Input
                type="text"
                value={newRule.ruleName}
                onChange={(e) => setNewRule({ ...newRule, ruleName: e.target.value })}
                placeholder="e.g., Images to Photos folder"
              />
            </FormField>
            <FormField label="Rule type">
              <Select
                value={newRule.ruleType}
                onChange={(e) =>
                  setNewRule({ ...newRule, ruleType: e.target.value as RuleType })
                }
              >
                <option value="extension">By extension</option>
                <option value="keyword">By keyword</option>
                <option value="date">By date</option>
                <option value="size">By size</option>
              </Select>
            </FormField>
            <FormField label="Target folder">
              <Input
                type="text"
                value={newRule.targetFolderPath}
                onChange={(e) =>
                  setNewRule({ ...newRule, targetFolderPath: e.target.value })
                }
                placeholder="/Photos"
              />
            </FormField>
            <Checkbox
              checked={newRule.autoApply}
              onChange={(e) => setNewRule({ ...newRule, autoApply: e.target.checked })}
              label="Auto-apply to new uploads"
            />
          </div>
        </ModalBody>
        <ModalFooter>
          <Button variant="secondary" onClick={() => setShowCreateRule(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => void handleCreateRule()}
            disabled={!newRule.ruleName || !newRule.targetFolderPath}
          >
            Create rule
          </Button>
        </ModalFooter>
      </Modal>
    </div>
  );
};

export default AutoOrganizeView;
