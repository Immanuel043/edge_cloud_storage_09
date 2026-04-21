import React from 'react';
import {
  File,
  Folder,
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
import { Badge, Card, EmptyState, IconButton } from '@/components/ui';
import { X } from 'lucide-react';

interface RelevanceDisplay {
  label: string;
  type: 'exact' | 'high' | 'good' | 'fair';
}

interface ModeInfo {
  icon: React.ReactElement;
  label: string;
  variant: 'info' | 'neutral';
}

/**
 * SearchResults — floating results card shown after a search runs.
 * Segments folders and files, tags each result with a relevance pill, and
 * annotates the active search mode (semantic / hybrid / keyword).
 */
const SearchResults: React.FC<SearchResultsProps> = ({
  results,
  onClose,
  onFileClick,
  onFolderClick,
}) => {
  if (!results) return null;

  const isSmartSearch = results.mode !== undefined;
  const searchMode: SearchMode | 'client-side' = results.mode || 'keyword';

  const RELEVANCE_THRESHOLD = 0.25;

  const getScore = (item: SearchHit): number => {
    if (item.hybrid_score !== undefined) return item.hybrid_score;
    if (item.semantic_score !== undefined) return item.semantic_score;
    return item.score || 0;
  };

  const maxScore = Math.max(
    ...(results.files?.hits?.map((f) => getScore(f)) || [0]),
    ...(results.folders?.hits?.map((f) => getScore(f)) || [0]),
    1
  );

  const effectiveThreshold =
    isSmartSearch && (searchMode === 'semantic' || searchMode === 'hybrid')
      ? 0.2
      : maxScore * RELEVANCE_THRESHOLD;

  const filteredFiles =
    results.files?.hits?.filter((f) => getScore(f) >= effectiveThreshold) || [];
  const filteredFolders =
    results.folders?.hits?.filter((f) => getScore(f) >= effectiveThreshold) || [];

  const totalFiles = filteredFiles.length;
  const totalFolders = filteredFolders.length;
  const totalResults = totalFiles + totalFolders;

  const getRelevanceDisplay = (score: number): RelevanceDisplay | null => {
    if (!score) return null;
    if (score >= 50) return { label: 'Exact match', type: 'exact' };
    if (score >= 10) return { label: 'High', type: 'high' };
    if (score >= 3) return { label: 'Good', type: 'good' };
    if (score >= 1) return { label: 'Relevant', type: 'fair' };
    return null;
  };

  const getModeInfo = (): ModeInfo => {
    switch (searchMode) {
      case 'semantic':
        return {
          icon: <Sparkles size={14} className="text-accent" />,
          label: 'Semantic',
          variant: 'info',
        };
      case 'hybrid':
        return {
          icon: <Zap size={14} className="text-primary" />,
          label: 'Hybrid',
          variant: 'info',
        };
      default:
        return {
          icon: <SearchIcon size={14} className="text-fg-subtle" />,
          label: 'Keyword',
          variant: 'neutral',
        };
    }
  };

  const modeInfo = getModeInfo();

  const getFileIcon = (mimeType: string | undefined): React.ReactElement => {
    if (!mimeType) return <File size={20} className="text-fg-subtle" />;
    if (mimeType.startsWith('image/')) return <Image size={20} className="text-accent" />;
    if (mimeType.startsWith('video/')) return <Video size={20} className="text-danger" />;
    if (mimeType.includes('pdf')) return <FileText size={20} className="text-danger" />;
    if (mimeType.includes('zip') || mimeType.includes('archive'))
      return <Archive size={20} className="text-warning" />;
    return <File size={20} className="text-primary" />;
  };

  const highlightText = (text: string, highlight: SearchHit['highlight'] | undefined): string => {
    if (!highlight || !highlight.name) return text;
    const highlightedText = highlight.name[0];
    if (!highlightedText) return text;
    const cleanHighlight = highlightedText.replace(/<\/?em>/g, '');
    return cleanHighlight || text;
  };

  return (
    <Card variant="bordered">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-h3 font-semibold text-fg">Search results</h3>
            {isSmartSearch && (
              <Badge variant={modeInfo.variant} size="sm" className="flex items-center gap-1">
                {modeInfo.icon}
                {modeInfo.label}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 text-body-sm text-fg-muted">
            {totalResults} result{totalResults !== 1 ? 's' : ''} found
            {totalFiles > 0 && ` (${totalFiles} file${totalFiles !== 1 ? 's' : ''})`}
            {totalFolders > 0 && ` (${totalFolders} folder${totalFolders !== 1 ? 's' : ''})`}
          </p>
        </div>
        <IconButton variant="ghost" size="sm" aria-label="Close search results" onClick={onClose}>
          <X className="h-4 w-4" />
        </IconButton>
      </div>

      <div className="max-h-96 overflow-y-auto">
        {filteredFolders.length > 0 && (
          <div className="border-b border-border p-2">
            <h4 className="px-2 py-1 text-caption font-semibold uppercase tracking-wider text-fg-muted">
              Folders
            </h4>
            {filteredFolders.map((folder) => (
              <div
                key={folder.id}
                onClick={() => {
                  onFolderClick(folder.id);
                  onClose();
                }}
                className="flex cursor-pointer items-center gap-3 rounded px-3 py-2 transition-colors hover:bg-surface-muted"
              >
                <Folder className="text-primary" size={20} />
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium text-fg">
                    {highlightText(folder.name, folder.highlight) || folder.name}
                  </p>
                  {folder.path && (
                    <p className="truncate text-caption text-fg-muted">{folder.path}</p>
                  )}
                </div>
                <div className="text-caption text-fg-muted">{formatDate(folder.created_at)}</div>
              </div>
            ))}
          </div>
        )}

        {filteredFiles.length > 0 && (
          <div className="p-2">
            <h4 className="px-2 py-1 text-caption font-semibold uppercase tracking-wider text-fg-muted">
              Files
            </h4>
            {filteredFiles.map((file) => {
              const relevance = getRelevanceDisplay(getScore(file));
              const isSemantic =
                file.semantic_score !== undefined || file.hybrid_score !== undefined;

              let relevanceVariant: 'success' | 'info' | 'neutral' = 'neutral';
              if (relevance?.type === 'exact') relevanceVariant = 'success';
              else if (relevance?.type === 'high') relevanceVariant = 'info';
              else if (isSemantic) relevanceVariant = 'info';

              return (
                <div
                  key={file.id}
                  onClick={() => {
                    onFileClick({ id: file.id, name: file.name });
                    onClose();
                  }}
                  className="flex cursor-pointer items-center gap-3 rounded px-3 py-2 transition-colors hover:bg-surface-muted"
                >
                  {getFileIcon(file.mime_type)}
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium text-fg">
                      {highlightText(file.name, file.highlight) || file.name}
                    </p>
                    <div className="mt-0.5 flex items-center gap-2 text-caption text-fg-muted">
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
                      <div className="mt-1 flex flex-wrap gap-1">
                        {file.tags.slice(0, 5).map((t) => (
                          <Badge
                            key={t.tag}
                            variant={
                              t.source === 'ai_vision' || t.source === 'ai_nlp' ? 'info' : 'neutral'
                            }
                            size="sm"
                          >
                            {t.tag}
                          </Badge>
                        ))}
                        {file.tags.length > 5 && (
                          <span className="text-caption text-fg-subtle">
                            +{file.tags.length - 5}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  {relevance && (
                    <Badge variant={relevanceVariant} size="sm" className="flex items-center gap-1">
                      {isSemantic && <Sparkles size={12} />}
                      {relevance.label}
                    </Badge>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {totalResults === 0 && (
          <EmptyState
            icon={<SearchIcon />}
            title="No results found"
            description="Try a different search term or adjust your filters."
            size="sm"
          />
        )}
      </div>
    </Card>
  );
};

export default SearchResults;
