import React, { useState, useEffect, useRef } from 'react';
import { Search, X, Filter, Loader2, Sparkles, Zap, Lock } from 'lucide-react';
import type {
  SearchBarProps,
  SearchFilters,
  SmartSearchStatus,
  SearchMode,
  SearchResults,
  SearchHit,
  FileItem,
} from './types';
import { API_URL } from '../../config/constants';
import { Badge, Button, FormField, Input, Select } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * SearchBar — dashboard search with autocomplete, smart search, and filters.
 * Server-side smart search (hybrid/semantic/keyword) for Edge users; falls
 * back to in-memory filtering for ZK users since their file names are
 * encrypted server-side.
 */
const SearchBar: React.FC<SearchBarProps> = ({ onSearch, zkMode = false, files = [] }) => {
  const [query, setQuery] = useState<string>('');
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState<boolean>(false);
  const [showFilters, setShowFilters] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(false);
  const [smartSearchEnabled, setSmartSearchEnabled] = useState<boolean>(true);
  const [searchMode, setSearchMode] = useState<SearchMode>('hybrid');
  const [smartSearchStatus, setSmartSearchStatus] = useState<SmartSearchStatus | null>(null);
  const [filters, setFilters] = useState<SearchFilters>({
    mime_type: '',
    storage_tier: '',
    size_min: '',
    size_max: '',
    date_from: '',
    date_to: '',
  });

  const searchRef = useRef<HTMLDivElement>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasFetchedSmartSearch = useRef(false);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent): void => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (zkMode) setSmartSearchEnabled(false);
  }, [zkMode]);

  const handleSearchFocus = (): void => {
    if (hasFetchedSmartSearch.current || zkMode) return;
    hasFetchedSmartSearch.current = true;

    const fetchSmartSearchStatus = async (): Promise<void> => {
      try {
        const response = await fetch(`${API_URL}/api/v1/search/smart/status`, {
          credentials: 'include',
        });
        if (response.ok) {
          const data = (await response.json()) as SmartSearchStatus;
          setSmartSearchStatus(data);
          if (!data.semantic_enabled) setSmartSearchEnabled(false);
        }
      } catch (error: unknown) {
        console.error('Failed to fetch smart search status:', error);
      }
    };
    void fetchSmartSearchStatus();
  };

  const fetchSuggestions = async (searchQuery: string): Promise<void> => {
    if (searchQuery.length < 2) {
      setSuggestions([]);
      return;
    }

    if (zkMode) {
      const searchLower = searchQuery.toLowerCase();
      const matchedNames = files
        .filter((f: FileItem) => (f.name || '').toLowerCase().includes(searchLower))
        .map((f: FileItem) => f.name)
        .slice(0, 5);
      setSuggestions(matchedNames);
      return;
    }

    try {
      const response = await fetch(
        `${API_URL}/api/v1/search/autocomplete?q=${encodeURIComponent(searchQuery)}`,
        { credentials: 'include' }
      );
      if (response.ok) {
        const data = (await response.json()) as { suggestions?: string[] };
        setSuggestions(data.suggestions || []);
      }
    } catch (error: unknown) {
      console.error('Autocomplete failed:', error);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const value = e.target.value;
    setQuery(value);
    setShowSuggestions(true);
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      void fetchSuggestions(value);
    }, 300);
  };

  const handleSearch = async (searchQuery: string = query): Promise<void> => {
    if (!searchQuery.trim()) return;
    setLoading(true);
    setShowSuggestions(false);

    try {
      if (zkMode) {
        const searchLower = searchQuery.toLowerCase();
        const matchedFiles = files.filter((file: FileItem) => {
          const fileName = (file.name || '').toLowerCase();
          const mimeType = (file.mime_type || '').toLowerCase();
          if (fileName.includes(searchLower)) return true;
          const ext = fileName.split('.').pop();
          if (ext && ext.includes(searchLower)) return true;
          if (mimeType.includes(searchLower)) return true;
          if (searchLower === 'image' && mimeType.startsWith('image/')) return true;
          if (searchLower === 'video' && mimeType.startsWith('video/')) return true;
          if (searchLower === 'audio' && mimeType.startsWith('audio/')) return true;
          if (searchLower === 'pdf' && mimeType === 'application/pdf') return true;
          if (
            searchLower === 'document' &&
            (mimeType.includes('document') ||
              mimeType.includes('pdf') ||
              mimeType.includes('text'))
          )
            return true;
          return false;
        });

        const results: SearchResults = {
          files: {
            hits: matchedFiles.map(
              (f: FileItem): SearchHit => ({
                id: f.id,
                name: f.name,
                size: f.size ?? undefined,
                mime_type: f.mime_type ?? undefined,
                created_at: f.created_at ?? undefined,
                is_encrypted: true,
                score: 1.0,
              })
            ),
            total: matchedFiles.length,
          },
          mode: 'client-side' as const,
          semantic_enabled: false,
          zk_mode: true,
        };
        onSearch(results);
        return;
      }

      const endpoint = smartSearchEnabled
        ? `${API_URL}/api/v1/search/smart`
        : `${API_URL}/api/v1/search/`;

      const activeFilters = Object.fromEntries(
        Object.entries(filters).filter(([, v]) => v !== '')
      );

      const requestBody = smartSearchEnabled
        ? {
            query: searchQuery,
            filters: activeFilters,
            size: 50,
            page: 1,
            mode: searchMode,
          }
        : {
            query: searchQuery,
            filters: activeFilters,
            size: 50,
            page: 1,
            fuzzy: true,
          };

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(requestBody),
      });

      if (response.ok) {
        const data = (await response.json()) as Record<string, unknown>;
        let results: SearchResults;
        if (smartSearchEnabled) {
          const dataResults = Array.isArray(data.results) ? (data.results as SearchHit[]) : [];
          const dataTotal = typeof data.total === 'number' ? data.total : 0;
          const dataMode = typeof data.mode === 'string' ? (data.mode as SearchMode) : undefined;
          const dataSemanticEnabled =
            typeof data.semantic_enabled === 'boolean' ? data.semantic_enabled : undefined;
          results = {
            files: { hits: dataResults, total: dataTotal },
            mode: dataMode,
            semantic_enabled: dataSemanticEnabled,
          };
        } else {
          results = data as SearchResults;
        }
        onSearch(results);
      }
    } catch (error: unknown) {
      console.error('Search failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') void handleSearch();
  };

  useEffect(() => {
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, []);

  const handleSuggestionClick = (suggestion: string): void => {
    setQuery(suggestion);
    setShowSuggestions(false);
    void handleSearch(suggestion);
  };

  const clearSearch = (): void => {
    setQuery('');
    setSuggestions([]);
    setShowSuggestions(false);
    onSearch(null);
  };

  const clearFilters = (): void => {
    setFilters({
      mime_type: '',
      storage_tier: '',
      size_min: '',
      size_max: '',
      date_from: '',
      date_to: '',
    });
  };

  const modeButtonClass = (active: boolean): string =>
    cn(
      'flex flex-1 items-center justify-center gap-1 rounded-md px-3 py-1.5 text-caption transition-colors',
      active
        ? 'bg-accent text-white'
        : 'bg-surface text-fg hover:bg-surface-muted'
    );

  return (
    <div className="relative" ref={searchRef}>
      {/* Search input */}
      <div className="relative">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-4 py-2.5 text-fg transition-colors focus-within:border-border-focus focus-within:shadow-focus">
          <Search className="h-5 w-5 text-fg-subtle" />
          <input
            type="text"
            value={query}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={handleSearchFocus}
            placeholder="Search files and folders..."
            className="flex-1 bg-transparent text-body outline-none placeholder:text-fg-subtle"
          />

          {loading && <Loader2 className="h-5 w-5 animate-spin text-primary" />}

          {query && (
            <button
              onClick={clearSearch}
              className="rounded p-1 transition-colors hover:bg-surface-muted"
              aria-label="Clear search"
            >
              <X className="h-4 w-4 text-fg-subtle" />
            </button>
          )}

          {zkMode ? (
            <div
              className="flex items-center gap-1 rounded bg-success px-1.5 py-1 text-white"
              title="Zero-Knowledge Mode: Searching encrypted files locally"
            >
              <Lock className="h-4 w-4" />
              <span className="hidden text-caption font-medium sm:inline">ZK</span>
            </div>
          ) : (
            <button
              onClick={() => setSmartSearchEnabled(!smartSearchEnabled)}
              className={cn(
                'flex items-center gap-1 rounded p-1.5 transition-colors',
                smartSearchEnabled
                  ? 'bg-accent text-white'
                  : 'text-fg-muted hover:bg-surface-muted'
              )}
              title={
                smartSearchEnabled
                  ? 'AI smart search enabled (click to disable)'
                  : 'Enable AI smart search'
              }
              disabled={smartSearchStatus === null || !smartSearchStatus.semantic_enabled}
            >
              <Sparkles className="h-4 w-4" />
              {smartSearchEnabled && (
                <span className="hidden text-caption font-medium sm:inline">AI</span>
              )}
            </button>
          )}

          {!zkMode && (
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={cn(
                'rounded p-1.5 transition-colors',
                showFilters
                  ? 'bg-primary text-white'
                  : 'text-fg-muted hover:bg-surface-muted'
              )}
              title="Filters"
              aria-label="Toggle filters"
            >
              <Filter className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Autocomplete */}
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute z-50 mt-1 w-full rounded-lg border border-border bg-surface-elevated shadow-lg">
            {suggestions.map((suggestion, index) => (
              <div
                key={index}
                onClick={() => handleSuggestionClick(suggestion)}
                className="cursor-pointer px-4 py-2 transition-colors hover:bg-surface-muted"
              >
                <div className="flex items-center gap-2">
                  <Search className="h-3.5 w-3.5 text-fg-subtle" />
                  <span className="text-body-sm text-fg">{suggestion}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Filters panel */}
      {showFilters && (
        <div className="absolute z-40 mt-2 w-full rounded-lg border border-border bg-surface-elevated p-4 shadow-lg">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="font-semibold text-fg">Search filters</h3>
            <Button variant="link" size="sm" onClick={clearFilters}>
              Clear all
            </Button>
          </div>

          {smartSearchEnabled && smartSearchStatus?.semantic_enabled && (
            <div className="mb-4 rounded-lg border border-accent/30 bg-accent/5 p-3">
              <div className="mb-2 flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-accent" />
                <span className="text-body-sm font-medium text-accent">AI search mode</span>
                {smartSearchStatus?.coverage_percent !== undefined && (
                  <Badge variant="info" size="sm">
                    {smartSearchStatus.coverage_percent}% indexed
                  </Badge>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setSearchMode('hybrid')}
                  className={modeButtonClass(searchMode === 'hybrid')}
                  title="Best of both: combines keyword and semantic search"
                >
                  <Zap className="h-3 w-3" />
                  Hybrid
                </button>
                <button
                  onClick={() => setSearchMode('semantic')}
                  className={modeButtonClass(searchMode === 'semantic')}
                  title="Find files by meaning (e.g., 'vacation photos')"
                >
                  <Sparkles className="h-3 w-3" />
                  Semantic
                </button>
                <button
                  onClick={() => setSearchMode('keyword')}
                  className={modeButtonClass(searchMode === 'keyword')}
                  title="Traditional exact keyword matching"
                >
                  <Search className="h-3 w-3" />
                  Keyword
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <FormField label="File type">
              <Select
                value={filters.mime_type}
                onChange={(e) => setFilters({ ...filters, mime_type: e.target.value })}
              >
                <option value="">All types</option>
                <option value="image/jpeg">JPEG images</option>
                <option value="image/png">PNG images</option>
                <option value="application/pdf">PDF documents</option>
                <option value="video/mp4">MP4 videos</option>
                <option value="video/quicktime">MOV videos</option>
                <option value="application/zip">ZIP archives</option>
                <option value="text/plain">Text files</option>
              </Select>
            </FormField>

            <FormField label="Storage tier">
              <Select
                value={filters.storage_tier}
                onChange={(e) => setFilters({ ...filters, storage_tier: e.target.value })}
              >
                <option value="">All tiers</option>
                <option value="cache">Cache</option>
                <option value="warm">Warm</option>
                <option value="cold">Cold</option>
              </Select>
            </FormField>

            <FormField label="Min size (MB)">
              <Input
                type="number"
                value={typeof filters.size_min === 'number' ? filters.size_min / 1048576 : ''}
                onChange={(e) =>
                  setFilters({
                    ...filters,
                    size_min: e.target.value ? parseInt(e.target.value) * 1048576 : '',
                  })
                }
                placeholder="0"
              />
            </FormField>

            <FormField label="Max size (MB)">
              <Input
                type="number"
                value={typeof filters.size_max === 'number' ? filters.size_max / 1048576 : ''}
                onChange={(e) =>
                  setFilters({
                    ...filters,
                    size_max: e.target.value ? parseInt(e.target.value) * 1048576 : '',
                  })
                }
                placeholder="1000"
              />
            </FormField>

            <FormField label="From date">
              <Input
                type="date"
                value={filters.date_from}
                onChange={(e) => setFilters({ ...filters, date_from: e.target.value })}
              />
            </FormField>

            <FormField label="To date">
              <Input
                type="date"
                value={filters.date_to}
                onChange={(e) => setFilters({ ...filters, date_to: e.target.value })}
              />
            </FormField>
          </div>

          <Button
            variant="primary"
            className="mt-4 w-full"
            onClick={() => void handleSearch()}
          >
            Apply filters
          </Button>
        </div>
      )}
    </div>
  );
};

export default SearchBar;
