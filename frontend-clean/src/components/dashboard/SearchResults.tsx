import React from 'react';
import {
  File,
  Folder,
  X,
  FileText,
  Image,
  Video,
  Archive,
  Sparkles,
  Zap,
  Search as SearchIcon,
} from 'lucide-react';
import { formatBytes, formatDate } from '../../utils/helpers';
import type { SearchResultsProps, SearchHit, SearchMode } from './types';

interface RelevanceDisplay {
  label: string;
  type: 'exact' | 'high' | 'good' | 'fair';
}

interface ModeInfo {
  icon: React.ReactElement;
  label: string;
  color: 'purple' | 'blue' | 'gray';
}

/**
 * SearchResults Component
 *
 * Displays search results with relevance indicators and file/folder sections.
 */
const SearchResults: React.FC<SearchResultsProps> = ({
  results,
  onClose,
  onFileClick,
  onFolderClick,
  darkMode,
}) => {
  if (!results) return null;

  // Check if this is a smart search result
  const isSmartSearch = results.mode !== undefined;
  const searchMode: SearchMode | 'client-side' = results.mode || 'keyword';

  // Minimum relevance threshold
  const RELEVANCE_THRESHOLD = 0.25;

  // Get the appropriate score based on search mode
  const getScore = (item: SearchHit): number => {
    if (item.hybrid_score !== undefined) return item.hybrid_score;
    if (item.semantic_score !== undefined) return item.semantic_score;
    return item.score || 0;
  };

  // Calculate max score for normalization
  const maxScore = Math.max(
    ...(results.files?.hits?.map((f) => getScore(f)) || [0]),
    ...(results.folders?.hits?.map((f) => getScore(f)) || [0]),
    1
  );

  // For semantic/hybrid search, scores are 0-1, so threshold differently
  const effectiveThreshold =
    isSmartSearch && (searchMode === 'semantic' || searchMode === 'hybrid')
      ? 0.2
      : maxScore * RELEVANCE_THRESHOLD;

  // Filter out low-relevance results
  const filteredFiles =
    results.files?.hits?.filter((f) => getScore(f) >= effectiveThreshold) || [];
  const filteredFolders =
    results.folders?.hits?.filter((f) => getScore(f) >= effectiveThreshold) || [];

  const totalFiles = filteredFiles.length;
  const totalFolders = filteredFolders.length;
  const totalResults = totalFiles + totalFolders;

  // Get a display-friendly relevance indicator
  const getRelevanceDisplay = (score: number): RelevanceDisplay | null => {
    if (!score) return null;

    if (score >= 50) {
      return { label: 'Exact Match', type: 'exact' };
    } else if (score >= 10) {
      return { label: 'High', type: 'high' };
    } else if (score >= 3) {
      return { label: 'Good', type: 'good' };
    } else if (score >= 1) {
      return { label: 'Relevant', type: 'fair' };
    }
    return null;
  };

  // Get search mode display info
  const getModeInfo = (): ModeInfo => {
    switch (searchMode) {
      case 'semantic':
        return {
          icon: <Sparkles size={14} className="text-purple-500" />,
          label: 'Semantic',
          color: 'purple',
        };
      case 'hybrid':
        return {
          icon: <Zap size={14} className="text-blue-500" />,
          label: 'Hybrid',
          color: 'blue',
        };
      default:
        return {
          icon: <SearchIcon size={14} className="text-gray-500" />,
          label: 'Keyword',
          color: 'gray',
        };
    }
  };

  const modeInfo = getModeInfo();

  const getFileIcon = (mimeType: string | undefined): React.ReactElement => {
    if (!mimeType) return <File size={20} />;

    if (mimeType.startsWith('image/')) return <Image size={20} className="text-purple-500" />;
    if (mimeType.startsWith('video/')) return <Video size={20} className="text-red-500" />;
    if (mimeType.includes('pdf')) return <FileText size={20} className="text-red-500" />;
    if (mimeType.includes('zip') || mimeType.includes('archive'))
      return <Archive size={20} className="text-yellow-500" />;

    return <File size={20} className="text-blue-500" />;
  };

  const highlightText = (
    text: string,
    highlight: SearchHit['highlight'] | undefined
  ): string => {
    if (!highlight || !highlight.name) return text;

    const highlightedText = highlight.name[0];
    if (!highlightedText) return text;

    // Remove HTML tags and get the highlighted portion
    const cleanHighlight = highlightedText.replace(/<\/?em>/g, '');
    return cleanHighlight || text;
  };

  return (
    <div
      className={`rounded-lg border ${
        darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
      }`}
    >
      {/* Header */}
      <div
        className={`flex items-center justify-between px-4 py-3 border-b ${
          darkMode ? 'border-gray-700' : 'border-gray-200'
        }`}
      >
        <div>
          <div className="flex items-center gap-2">
            <h3 className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Search Results
            </h3>
            {isSmartSearch && (
              <span
                className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${
                  modeInfo.color === 'purple'
                    ? darkMode
                      ? 'bg-purple-900/30 text-purple-400'
                      : 'bg-purple-100 text-purple-600'
                    : modeInfo.color === 'blue'
                      ? darkMode
                        ? 'bg-blue-900/30 text-blue-400'
                        : 'bg-blue-100 text-blue-600'
                      : darkMode
                        ? 'bg-gray-700 text-gray-400'
                        : 'bg-gray-100 text-gray-600'
                }`}
              >
                {modeInfo.icon}
                {modeInfo.label}
              </span>
            )}
          </div>
          <p className={`text-sm mt-0.5 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            {totalResults} result{totalResults !== 1 ? 's' : ''} found
            {totalFiles > 0 && ` (${totalFiles} file${totalFiles !== 1 ? 's' : ''})`}
            {totalFolders > 0 && ` (${totalFolders} folder${totalFolders !== 1 ? 's' : ''})`}
          </p>
        </div>
        <button onClick={onClose} className={`p-1 rounded hover:bg-gray-200 dark:hover:bg-gray-700`}>
          <X size={20} />
        </button>
      </div>

      {/* Results List */}
      <div className="max-h-96 overflow-y-auto">
        {/* Folders */}
        {filteredFolders.length > 0 && (
          <div className={`p-2 border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
            <h4
              className={`text-xs font-semibold uppercase tracking-wider px-2 py-1 ${
                darkMode ? 'text-gray-400' : 'text-gray-500'
              }`}
            >
              Folders
            </h4>
            {filteredFolders.map((folder) => (
              <div
                key={folder.id}
                onClick={() => {
                  onFolderClick(folder.id);
                  onClose();
                }}
                className={`flex items-center gap-3 px-3 py-2 rounded cursor-pointer transition-colors ${
                  darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-50'
                }`}
              >
                <Folder className="text-blue-500" size={20} />
                <div className="flex-1 min-w-0">
                  <p className={`font-medium truncate ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    {highlightText(folder.name, folder.highlight) || folder.name}
                  </p>
                  {folder.path && (
                    <p
                      className={`text-xs truncate ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}
                    >
                      {folder.path}
                    </p>
                  )}
                </div>
                <div className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  {formatDate(folder.created_at)}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Files */}
        {filteredFiles.length > 0 && (
          <div className="p-2">
            <h4
              className={`text-xs font-semibold uppercase tracking-wider px-2 py-1 ${
                darkMode ? 'text-gray-400' : 'text-gray-500'
              }`}
            >
              Files
            </h4>
            {filteredFiles.map((file) => (
              <div
                key={file.id}
                onClick={() => {
                  onFileClick({ id: file.id, name: file.name });
                  onClose();
                }}
                className={`flex items-center gap-3 px-3 py-2 rounded cursor-pointer transition-colors ${
                  darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-50'
                }`}
              >
                {getFileIcon(file.mime_type)}
                <div className="flex-1 min-w-0">
                  <p className={`font-medium truncate ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    {highlightText(file.name, file.highlight) || file.name}
                  </p>
                  <div
                    className={`flex items-center gap-2 mt-0.5 text-xs ${
                      darkMode ? 'text-gray-400' : 'text-gray-500'
                    }`}
                  >
                    <span>{formatBytes(file.size ?? 0)}</span>
                    <span>•</span>
                    <span>{formatDate(file.created_at)}</span>
                    {file.storage_tier && (
                      <>
                        <span>•</span>
                        <span className="capitalize">{file.storage_tier}</span>
                      </>
                    )}
                  </div>
                  {file.tags && file.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {file.tags.slice(0, 5).map((t) => (
                        <span
                          key={t.tag}
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
                            t.source === 'ai_vision' || t.source === 'ai_nlp'
                              ? darkMode
                                ? 'bg-purple-900/30 text-purple-400'
                                : 'bg-purple-100 text-purple-700'
                              : darkMode
                                ? 'bg-gray-700 text-gray-300'
                                : 'bg-gray-100 text-gray-600'
                          }`}
                        >
                          {t.tag}
                        </span>
                      ))}
                      {file.tags.length > 5 && (
                        <span className={`text-[10px] ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                          +{file.tags.length - 5}
                        </span>
                      )}
                    </div>
                  )}
                </div>
                {(() => {
                  const relevance = getRelevanceDisplay(getScore(file));
                  if (!relevance) return null;

                  const isSemantic =
                    file.semantic_score !== undefined || file.hybrid_score !== undefined;
                  const bgClass =
                    relevance.type === 'exact'
                      ? darkMode
                        ? 'bg-green-900/20 text-green-400'
                        : 'bg-green-50 text-green-600'
                      : relevance.type === 'high'
                        ? darkMode
                          ? 'bg-blue-900/20 text-blue-400'
                          : 'bg-blue-50 text-blue-600'
                        : isSemantic
                          ? darkMode
                            ? 'bg-purple-900/20 text-purple-400'
                            : 'bg-purple-50 text-purple-600'
                          : darkMode
                            ? 'bg-gray-700 text-gray-300'
                            : 'bg-gray-100 text-gray-600';

                  return (
                    <div className={`flex items-center gap-1 text-xs px-2 py-1 rounded ${bgClass}`}>
                      {isSemantic && <Sparkles size={12} />}
                      {relevance.label}
                    </div>
                  );
                })()}
              </div>
            ))}
          </div>
        )}

        {/* No Results */}
        {totalResults === 0 && (
          <div className="p-8 text-center">
            <p className={`${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              No results found. Try a different search term or adjust your filters.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default SearchResults;
