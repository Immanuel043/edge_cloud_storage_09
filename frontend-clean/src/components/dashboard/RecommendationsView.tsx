import React, { useState, useEffect } from 'react';
import {
  Lightbulb,
  Loader,
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
  Brain
} from 'lucide-react';
import { recommendationService } from '../../services/recommendationService';
import { formatBytes } from '../../utils/helpers';
import type { RecommendationsViewProps, Recommendation, RecommendationSummary, TrendingFile } from './types';
import { getErrorMessage } from './types';

type AlgorithmType = 'hybrid' | 'content' | 'collaborative' | 'trending';
type TabType = 'forYou' | 'trending';

interface AlgorithmBadge {
  label: string;
  color: string;
  icon: React.ReactElement;
}

/**
 * RecommendationsView - Displays AI-powered file recommendations
 */
const RecommendationsView: React.FC<RecommendationsViewProps> = ({ darkMode, onFileClick }) => {
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [trending, setTrending] = useState<TrendingFile[]>([]);
  const [summary, setSummary] = useState<RecommendationSummary | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('forYou');
  const [algorithm, setAlgorithm] = useState<AlgorithmType>('hybrid');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async (forceRefresh = false): Promise<void> => {
    try {
      setLoading(!forceRefresh);
      setRefreshing(forceRefresh);
      setError(null);

      const [recsData, trendingData, summaryData] = await Promise.all([
        recommendationService.getRecommendations({ algorithm, forceRefresh }).catch(() => []),
        recommendationService.getTrending(10, 7).catch(() => []),
        recommendationService.getSummary().catch(() => null)
      ]);

      setRecommendations((recsData as unknown) as Recommendation[]);
      setTrending((trendingData as unknown) as TrendingFile[]);
      setSummary((summaryData as unknown) as RecommendationSummary | null);
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
    loadData(true);
  };

  const handleAlgorithmChange = async (newAlgorithm: AlgorithmType): Promise<void> => {
    setAlgorithm(newAlgorithm);
    try {
      setRefreshing(true);
      const recsData = await recommendationService.getRecommendations({ algorithm: newAlgorithm });
      setRecommendations((recsData as unknown) as Recommendation[]);
    } catch (err: unknown) {
      console.error('[Recommendations] Failed to change algorithm:', err);
    } finally {
      setRefreshing(false);
    }
  };

  const handleDismiss = async (recId: string): Promise<void> => {
    try {
      await recommendationService.dismissRecommendation(recId);
      setRecommendations(prev => prev.filter(r => r.id !== recId));
    } catch (err: unknown) {
      console.error('[Recommendations] Dismiss failed:', err);
    }
  };

  const handleFeedback = async (recId: string, isHelpful: boolean): Promise<void> => {
    try {
      await recommendationService.submitFeedback(recId, isHelpful, isHelpful ? 'accept' : 'dismiss');
      // Update UI to show feedback was recorded
      setRecommendations(prev => prev.map(r =>
        r.id === recId ? { ...r, feedbackGiven: isHelpful ? 'positive' : 'negative' } : r
      ));
    } catch (err: unknown) {
      console.error('[Recommendations] Feedback failed:', err);
    }
  };

  const getFileIcon = (mimeType?: string): React.ReactElement => {
    if (!mimeType) return <File size={20} />;
    if (mimeType.startsWith('image/')) return <Image size={20} className="text-purple-500" />;
    if (mimeType.startsWith('video/')) return <Video size={20} className="text-red-500" />;
    if (mimeType.startsWith('audio/')) return <Music size={20} className="text-green-500" />;
    if (mimeType.includes('pdf') || mimeType.includes('document')) return <FileText size={20} className="text-blue-500" />;
    if (mimeType.includes('zip') || mimeType.includes('archive')) return <Archive size={20} className="text-yellow-500" />;
    if (mimeType.includes('javascript') || mimeType.includes('json')) return <Code size={20} className="text-orange-500" />;
    return <File size={20} />;
  };

  const getReasonIcon = (reason?: string): React.ReactElement => {
    if (reason?.includes('similar')) return <Sparkles size={14} className="text-purple-500" />;
    if (reason?.includes('trending')) return <TrendingUp size={14} className="text-green-500" />;
    if (reason?.includes('collaborative')) return <Users size={14} className="text-blue-500" />;
    return <Brain size={14} className="text-orange-500" />;
  };

  const getAlgorithmBadge = (algo: AlgorithmType): AlgorithmBadge => {
    const badges: Record<AlgorithmType, AlgorithmBadge> = {
      'hybrid': { label: 'Hybrid', color: 'purple', icon: <Zap size={12} /> },
      'content': { label: 'Content', color: 'blue', icon: <FileText size={12} /> },
      'collaborative': { label: 'Collaborative', color: 'green', icon: <Users size={12} /> },
      'trending': { label: 'Trending', color: 'orange', icon: <TrendingUp size={12} /> }
    };
    return badges[algo] || badges['hybrid'];
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12 space-y-4">
        <Loader className="animate-spin text-blue-500" size={48} />
        <p className={`${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          Loading recommendations...
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`p-3 rounded-xl ${darkMode ? 'bg-yellow-900/30' : 'bg-yellow-100'}`}>
            <Lightbulb className="text-yellow-500" size={28} />
          </div>
          <div>
            <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Recommendations
            </h1>
            <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              AI-powered file suggestions based on your usage
            </p>
          </div>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all ${
            darkMode ? 'bg-gray-700 hover:bg-gray-600 text-white' : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
          }`}
          type="button"
        >
          <RefreshCw className={refreshing ? 'animate-spin' : ''} size={18} />
          Refresh
        </button>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <div className={`rounded-lg p-4 ${darkMode ? 'bg-gray-800' : 'bg-white'} border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
            <div className="flex items-center gap-2 mb-2">
              <Lightbulb size={18} className="text-yellow-500" />
              <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>Total Suggestions</span>
            </div>
            <div className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              {summary.total_recommendations || 0}
            </div>
          </div>
          <div className={`rounded-lg p-4 ${darkMode ? 'bg-gray-800' : 'bg-white'} border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
            <div className="flex items-center gap-2 mb-2">
              <ThumbsUp size={18} className="text-green-500" />
              <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>Accepted</span>
            </div>
            <div className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              {summary.accepted || 0}
            </div>
          </div>
          <div className={`rounded-lg p-4 ${darkMode ? 'bg-gray-800' : 'bg-white'} border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
            <div className="flex items-center gap-2 mb-2">
              <Star size={18} className="text-purple-500" />
              <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>Accuracy</span>
            </div>
            <div className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              {summary.accuracy ? `${Math.round(summary.accuracy * 100)}%` : 'N/A'}
            </div>
          </div>
          <div className={`rounded-lg p-4 ${darkMode ? 'bg-gray-800' : 'bg-white'} border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp size={18} className="text-blue-500" />
              <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>Trending Files</span>
            </div>
            <div className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              {trending.length}
            </div>
          </div>
        </div>
      )}

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
          onClick={() => setActiveTab('forYou')}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md transition-all ${
            activeTab === 'forYou'
              ? darkMode ? 'bg-yellow-600 text-white' : 'bg-white text-yellow-600 shadow'
              : darkMode ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-900'
          }`}
          type="button"
        >
          <Sparkles size={18} />
          For You ({recommendations.length})
        </button>
        <button
          onClick={() => setActiveTab('trending')}
          className={`flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-md transition-all ${
            activeTab === 'trending'
              ? darkMode ? 'bg-yellow-600 text-white' : 'bg-white text-yellow-600 shadow'
              : darkMode ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-900'
          }`}
          type="button"
        >
          <TrendingUp size={18} />
          Trending ({trending.length})
        </button>
      </div>

      {/* Algorithm Selector (for For You tab) */}
      {activeTab === 'forYou' && (
        <div className="flex items-center gap-2">
          <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>Algorithm:</span>
          {(['hybrid', 'content', 'collaborative', 'trending'] as AlgorithmType[]).map((algo) => {
            const badge = getAlgorithmBadge(algo);
            const colorClass = algorithm === algo
              ? `bg-${badge.color}-600 text-white`
              : darkMode
                ? 'bg-gray-700 text-gray-300 hover:bg-gray-600'
                : 'bg-gray-200 text-gray-700 hover:bg-gray-300';
            return (
              <button
                key={algo}
                onClick={() => handleAlgorithmChange(algo)}
                className={`flex items-center gap-1 px-3 py-1 rounded-full text-sm transition-all ${colorClass}`}
                type="button"
              >
                {badge.icon}
                {badge.label}
              </button>
            );
          })}
        </div>
      )}

      {/* For You Tab */}
      {activeTab === 'forYou' && (
        <div className="space-y-3">
          {recommendations.length === 0 ? (
            <div className={`rounded-lg p-8 text-center ${darkMode ? 'bg-gray-800' : 'bg-white'} border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
              <Lightbulb className={`mx-auto mb-4 ${darkMode ? 'text-gray-600' : 'text-gray-400'}`} size={48} />
              <h3 className={`text-lg font-medium mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                No Recommendations Yet
              </h3>
              <p className={`mb-4 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                Upload more files and interact with them to get personalized recommendations
              </p>
            </div>
          ) : (
            recommendations.map((rec) => (
              <div
                key={rec.id}
                className={`rounded-lg p-4 ${darkMode ? 'bg-gray-800' : 'bg-white'} border ${darkMode ? 'border-gray-700' : 'border-gray-200'} hover:shadow-lg transition-shadow cursor-pointer`}
                onClick={() => onFileClick?.(rec.recommended_file)}
              >
                <div className="flex items-start justify-between">
                  <div className="flex items-start gap-3">
                    <div className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                      {getFileIcon(rec.recommended_file?.mime_type)}
                    </div>
                    <div>
                      <h3 className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                        {rec.recommended_file?.name || 'Unknown File'}
                      </h3>
                      <div className="flex items-center gap-2 mt-1">
                        <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                          {formatBytes(rec.recommended_file?.size || 0)}
                        </span>
                        <span className={`text-sm ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>•</span>
                        <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                          {rec.recommended_file?.storage_tier || 'cache'}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 mt-2">
                        {getReasonIcon(rec.reason)}
                        <span className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                          {rec.reason || 'Based on your activity'}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className={`text-sm font-medium px-2 py-1 rounded ${
                      (rec.recommendation_score || 0) > 0.7
                        ? darkMode ? 'bg-green-900/30 text-green-400' : 'bg-green-100 text-green-700'
                        : (rec.recommendation_score || 0) > 0.5
                          ? darkMode ? 'bg-yellow-900/30 text-yellow-400' : 'bg-yellow-100 text-yellow-700'
                          : darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-100 text-gray-700'
                    }`}>
                      {Math.round((rec.recommendation_score || 0) * 100)}% match
                    </div>
                    {!rec.feedbackGiven && (
                      <div className="flex gap-1">
                        <button
                          onClick={(e) => { e.stopPropagation(); handleFeedback(rec.id, true); }}
                          className={`p-1.5 rounded-lg ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                          type="button"
                        >
                          <ThumbsUp size={16} className={darkMode ? 'text-gray-400' : 'text-gray-600'} />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); handleFeedback(rec.id, false); }}
                          className={`p-1.5 rounded-lg ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                          type="button"
                        >
                          <ThumbsDown size={16} className={darkMode ? 'text-gray-400' : 'text-gray-600'} />
                        </button>
                      </div>
                    )}
                    {rec.feedbackGiven && (
                      <span className={`text-xs ${rec.feedbackGiven === 'positive' ? 'text-green-500' : 'text-red-500'}`}>
                        {rec.feedbackGiven === 'positive' ? 'Liked' : 'Dismissed'}
                      </span>
                    )}
                    <button
                      onClick={(e) => { e.stopPropagation(); handleDismiss(rec.id); }}
                      className={`p-1.5 rounded-lg ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                      type="button"
                    >
                      <X size={16} className={darkMode ? 'text-gray-400' : 'text-gray-600'} />
                    </button>
                  </div>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* Trending Tab */}
      {activeTab === 'trending' && (
        <div className="space-y-3">
          {trending.length === 0 ? (
            <div className={`rounded-lg p-8 text-center ${darkMode ? 'bg-gray-800' : 'bg-white'} border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
              <TrendingUp className={`mx-auto mb-4 ${darkMode ? 'text-gray-600' : 'text-gray-400'}`} size={48} />
              <h3 className={`text-lg font-medium mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                No Trending Files
              </h3>
              <p className={`${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                Your most accessed files will appear here
              </p>
            </div>
          ) : (
            trending.map((file, index) => (
              <div
                key={file.id || index}
                className={`rounded-lg p-4 ${darkMode ? 'bg-gray-800' : 'bg-white'} border ${darkMode ? 'border-gray-700' : 'border-gray-200'} hover:shadow-lg transition-shadow cursor-pointer`}
                onClick={() => onFileClick?.(file)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold ${
                      index === 0 ? 'bg-yellow-500 text-white' :
                      index === 1 ? 'bg-gray-400 text-white' :
                      index === 2 ? 'bg-orange-600 text-white' :
                      darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'
                    }`}>
                      {index + 1}
                    </div>
                    <div className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                      {getFileIcon(file.mime_type)}
                    </div>
                    <div>
                      <h3 className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                        {file.name || file.file_name || 'Unknown File'}
                      </h3>
                      <div className="flex items-center gap-2 mt-1">
                        <Eye size={14} className={darkMode ? 'text-gray-500' : 'text-gray-400'} />
                        <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                          {file.access_count || file.interaction_count || 0} views
                        </span>
                        <span className={`text-sm ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>•</span>
                        <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                          {formatBytes(file.size || file.file_size || 0)}
                        </span>
                      </div>
                    </div>
                  </div>
                  <ChevronRight size={20} className={darkMode ? 'text-gray-500' : 'text-gray-400'} />
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};

export default RecommendationsView;
