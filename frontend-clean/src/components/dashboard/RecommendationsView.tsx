import React, { useState, useEffect } from 'react';
import {
  Lightbulb,
  AlertCircle,
  RefreshCw,
  Sparkles,
  TrendingUp,
  Eye,
  X,
  ThumbsUp,
  ThumbsDown,
  FileText,
  Image,
  Video,
  Music,
  Archive,
  Code,
  File,
  Star,
  ChevronRight,
  Zap,
  Users,
  Brain,
} from 'lucide-react';
import { recommendationService } from '../../services/recommendationService';
import { formatBytes } from '../../utils/helpers';
import type {
  RecommendationsViewProps,
  Recommendation,
  RecommendationSummary,
  TrendingFile,
} from './types';
import { getErrorMessage } from './types';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  EmptyState,
  IconButton,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@/components/ui';
import { cn } from '@/lib/cn';

type AlgorithmType = 'hybrid' | 'content' | 'collaborative' | 'trending';
type TabType = 'forYou' | 'trending';

interface AlgorithmBadge {
  label: string;
  icon: React.ReactElement;
}

/**
 * RecommendationsView — AI-powered file recommendations. "For you" tab
 * uses hybrid/content/collaborative/trending algorithms with thumbs-up /
 * thumbs-down feedback loop; "Trending" tab ranks most-accessed files.
 * Summary stats show total/accepted/accuracy/trending counts.
 */
const RecommendationsView: React.FC<RecommendationsViewProps> = ({ onFileClick }) => {
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [trending, setTrending] = useState<TrendingFile[]>([]);
  const [summary, setSummary] = useState<RecommendationSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('forYou');
  const [algorithm, setAlgorithm] = useState<AlgorithmType>('hybrid');

  useEffect(() => {
    void loadData();
  }, []);

  const loadData = async (forceRefresh = false): Promise<void> => {
    try {
      setLoading(!forceRefresh);
      setRefreshing(forceRefresh);
      setError(null);

      const [recsData, trendingData, summaryData] = await Promise.all([
        recommendationService.getRecommendations({ algorithm, forceRefresh }).catch(() => []),
        recommendationService.getTrending(10, 7).catch(() => []),
        recommendationService.getSummary().catch(() => null),
      ]);

      setRecommendations(recsData as unknown as Recommendation[]);
      setTrending(trendingData as unknown as TrendingFile[]);
      setSummary(summaryData as unknown as RecommendationSummary | null);
    } catch (err: unknown) {
      const errorMessage = getErrorMessage(err);
      console.error('[Recommendations] Failed to load:', err);
      setError(errorMessage);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  const handleRefresh = (): void => {
    void loadData(true);
  };

  const handleAlgorithmChange = async (newAlgorithm: AlgorithmType): Promise<void> => {
    setAlgorithm(newAlgorithm);
    try {
      setRefreshing(true);
      const recsData = await recommendationService.getRecommendations({
        algorithm: newAlgorithm,
      });
      setRecommendations(recsData as unknown as Recommendation[]);
    } catch (err: unknown) {
      console.error('[Recommendations] Failed to change algorithm:', err);
    } finally {
      setRefreshing(false);
    }
  };

  const handleDismiss = async (recId: string): Promise<void> => {
    try {
      await recommendationService.dismissRecommendation(recId);
      setRecommendations((prev) => prev.filter((r) => r.id !== recId));
    } catch (err: unknown) {
      console.error('[Recommendations] Dismiss failed:', err);
    }
  };

  const handleFeedback = async (recId: string, isHelpful: boolean): Promise<void> => {
    try {
      await recommendationService.submitFeedback(
        recId,
        isHelpful,
        isHelpful ? 'accept' : 'dismiss'
      );
      setRecommendations((prev) =>
        prev.map((r) =>
          r.id === recId ? { ...r, feedbackGiven: isHelpful ? 'positive' : 'negative' } : r
        )
      );
    } catch (err: unknown) {
      console.error('[Recommendations] Feedback failed:', err);
    }
  };

  const getFileIcon = (mimeType?: string): React.ReactElement => {
    if (!mimeType) return <File className="h-5 w-5" />;
    if (mimeType.startsWith('image/')) return <Image className="h-5 w-5 text-accent" />;
    if (mimeType.startsWith('video/')) return <Video className="h-5 w-5 text-danger" />;
    if (mimeType.startsWith('audio/')) return <Music className="h-5 w-5 text-success" />;
    if (mimeType.includes('pdf') || mimeType.includes('document'))
      return <FileText className="h-5 w-5 text-primary" />;
    if (mimeType.includes('zip') || mimeType.includes('archive'))
      return <Archive className="h-5 w-5 text-warning" />;
    if (mimeType.includes('javascript') || mimeType.includes('json'))
      return <Code className="h-5 w-5 text-accent" />;
    return <File className="h-5 w-5" />;
  };

  const getReasonIcon = (reason?: string): React.ReactElement => {
    if (reason?.includes('similar'))
      return <Sparkles className="h-3.5 w-3.5 text-accent" />;
    if (reason?.includes('trending'))
      return <TrendingUp className="h-3.5 w-3.5 text-success" />;
    if (reason?.includes('collaborative'))
      return <Users className="h-3.5 w-3.5 text-primary" />;
    return <Brain className="h-3.5 w-3.5 text-warning" />;
  };

  const getAlgorithmBadge = (algo: AlgorithmType): AlgorithmBadge => {
    const badges: Record<AlgorithmType, AlgorithmBadge> = {
      hybrid: { label: 'Hybrid', icon: <Zap className="h-3 w-3" /> },
      content: { label: 'Content', icon: <FileText className="h-3 w-3" /> },
      collaborative: { label: 'Collaborative', icon: <Users className="h-3 w-3" /> },
      trending: { label: 'Trending', icon: <TrendingUp className="h-3 w-3" /> },
    };
    return badges[algo] || badges.hybrid;
  };

  const getMatchScoreVariant = (score: number): 'success' | 'warning' | 'neutral' => {
    if (score > 0.7) return 'success';
    if (score > 0.5) return 'warning';
    return 'neutral';
  };

  const rankBadgeClass = (index: number): string => {
    if (index === 0) return 'bg-warning text-white';
    if (index === 1) return 'bg-fg-muted text-white';
    if (index === 2) return 'bg-danger text-white';
    return 'bg-surface-muted text-fg';
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
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-warning/10 text-warning">
            <Lightbulb className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-h2 font-bold text-fg">Recommendations</h1>
            <p className="text-body-sm text-fg-muted">
              AI-powered file suggestions based on your usage
            </p>
          </div>
        </div>
        <Button
          variant="secondary"
          size="md"
          leftIcon={<RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />}
          onClick={handleRefresh}
          disabled={refreshing}
          loading={refreshing}
        >
          Refresh
        </Button>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
          <SummaryCard
            icon={<Lightbulb className="h-4 w-4 text-warning" />}
            label="Total suggestions"
            value={summary.total_recommendations || 0}
          />
          <SummaryCard
            icon={<ThumbsUp className="h-4 w-4 text-success" />}
            label="Accepted"
            value={summary.accepted || 0}
          />
          <SummaryCard
            icon={<Star className="h-4 w-4 text-accent" />}
            label="Accuracy"
            value={summary.accuracy ? `${Math.round(summary.accuracy * 100)}%` : 'N/A'}
          />
          <SummaryCard
            icon={<TrendingUp className="h-4 w-4 text-primary" />}
            label="Trending files"
            value={trending.length}
          />
        </div>
      )}

      {/* Error */}
      {error && (
        <Banner variant="danger" icon={<AlertCircle />} onDismiss={() => setError(null)}>
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
          <TabsTrigger value="forYou" className="flex-1 justify-center gap-2">
            <Sparkles className="h-4 w-4" />
            For you ({recommendations.length})
          </TabsTrigger>
          <TabsTrigger value="trending" className="flex-1 justify-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Trending ({trending.length})
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {/* Algorithm Selector */}
      {activeTab === 'forYou' && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-body-sm text-fg-muted">Algorithm:</span>
          {(['hybrid', 'content', 'collaborative', 'trending'] as AlgorithmType[]).map(
            (algo) => {
              const badge = getAlgorithmBadge(algo);
              const active = algorithm === algo;
              return (
                <button
                  key={algo}
                  onClick={() => void handleAlgorithmChange(algo)}
                  className={cn(
                    'flex items-center gap-1 rounded-full px-3 py-1 text-body-sm transition-colors duration-base',
                    active
                      ? 'bg-primary text-white'
                      : 'bg-surface-muted text-fg hover:bg-surface'
                  )}
                  type="button"
                >
                  {badge.icon}
                  {badge.label}
                </button>
              );
            }
          )}
        </div>
      )}

      {/* For You Tab */}
      {activeTab === 'forYou' && (
        <div className="space-y-3">
          {recommendations.length === 0 ? (
            <Card variant="bordered">
              <CardContent className="p-6">
                <EmptyState
                  icon={<Lightbulb />}
                  title="No recommendations yet"
                  description="Upload more files and interact with them to get personalized recommendations."
                  size="lg"
                />
              </CardContent>
            </Card>
          ) : (
            recommendations.map((rec) => (
              <Card
                key={rec.id}
                variant="bordered"
                className="cursor-pointer transition-shadow hover:shadow-md"
              >
                <CardContent
                  className="p-4"
                  onClick={() => onFileClick?.(rec.recommended_file)}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-muted">
                        {getFileIcon(rec.recommended_file?.mime_type)}
                      </div>
                      <div>
                        <h3 className="font-semibold text-fg">
                          {rec.recommended_file?.name || 'Unknown file'}
                        </h3>
                        <div className="mt-1 flex items-center gap-2 text-body-sm text-fg-muted">
                          <span>{formatBytes(rec.recommended_file?.size || 0)}</span>
                          <span>•</span>
                          <span>{rec.recommended_file?.storage_tier || 'cache'}</span>
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          {getReasonIcon(rec.reason)}
                          <span className="text-caption text-fg-muted">
                            {rec.reason || 'Based on your activity'}
                          </span>
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge
                        variant={getMatchScoreVariant(rec.recommendation_score || 0)}
                        size="sm"
                      >
                        {Math.round((rec.recommendation_score || 0) * 100)}% match
                      </Badge>
                      {!rec.feedbackGiven && (
                        <div className="flex gap-1">
                          <IconButton
                            variant="ghost"
                            size="sm"
                            aria-label="Helpful"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleFeedback(rec.id, true);
                            }}
                          >
                            <ThumbsUp className="h-4 w-4" />
                          </IconButton>
                          <IconButton
                            variant="ghost"
                            size="sm"
                            aria-label="Not helpful"
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleFeedback(rec.id, false);
                            }}
                          >
                            <ThumbsDown className="h-4 w-4" />
                          </IconButton>
                        </div>
                      )}
                      {rec.feedbackGiven && (
                        <span
                          className={cn(
                            'text-caption',
                            rec.feedbackGiven === 'positive' ? 'text-success' : 'text-danger'
                          )}
                        >
                          {rec.feedbackGiven === 'positive' ? 'Liked' : 'Dismissed'}
                        </span>
                      )}
                      <IconButton
                        variant="ghost"
                        size="sm"
                        aria-label="Dismiss"
                        onClick={(e) => {
                          e.stopPropagation();
                          void handleDismiss(rec.id);
                        }}
                      >
                        <X className="h-4 w-4" />
                      </IconButton>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}

      {/* Trending Tab */}
      {activeTab === 'trending' && (
        <div className="space-y-3">
          {trending.length === 0 ? (
            <Card variant="bordered">
              <CardContent className="p-6">
                <EmptyState
                  icon={<TrendingUp />}
                  title="No trending files"
                  description="Your most accessed files will appear here."
                  size="lg"
                />
              </CardContent>
            </Card>
          ) : (
            trending.map((file, index) => (
              <Card
                key={file.id || index}
                variant="bordered"
                className="cursor-pointer transition-shadow hover:shadow-md"
              >
                <CardContent className="p-4" onClick={() => onFileClick?.(file)}>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className={cn(
                          'flex h-8 w-8 items-center justify-center rounded-full font-bold',
                          rankBadgeClass(index)
                        )}
                      >
                        {index + 1}
                      </div>
                      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-muted">
                        {getFileIcon(file.mime_type)}
                      </div>
                      <div>
                        <h3 className="font-semibold text-fg">
                          {file.name || file.file_name || 'Unknown file'}
                        </h3>
                        <div className="mt-1 flex items-center gap-2 text-body-sm text-fg-muted">
                          <Eye className="h-3.5 w-3.5" />
                          <span>
                            {file.access_count || file.interaction_count || 0} views
                          </span>
                          <span>•</span>
                          <span>{formatBytes(file.size || file.file_size || 0)}</span>
                        </div>
                      </div>
                    </div>
                    <ChevronRight className="h-5 w-5 text-fg-muted" />
                  </div>
                </CardContent>
              </Card>
            ))
          )}
        </div>
      )}
    </div>
  );
};

const SummaryCard: React.FC<{
  icon: React.ReactNode;
  label: string;
  value: string | number;
}> = ({ icon, label, value }) => (
  <Card variant="bordered">
    <CardContent className="p-4">
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <span className="text-body-sm text-fg-muted">{label}</span>
      </div>
      <div className="text-h2 font-bold text-fg">{value}</div>
    </CardContent>
  </Card>
);

export default RecommendationsView;
