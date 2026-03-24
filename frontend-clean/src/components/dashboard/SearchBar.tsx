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

/**
 * SearchBar Component
 *
 * Search input with autocomplete, smart search, and filters.
 * Supports both server-side and client-side (ZK) search modes.
 */
const SearchBar: React.FC<SearchBarProps> = ({
  onSearch,
  darkMode,
  zkMode = false,
  files = [],
}) => {
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
    // Click outside to close suggestions
    const handleClickOutside = (event: MouseEvent): void => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Disable smart search for ZK users on mount
  useEffect(() => {
    if (zkMode) {
      setSmartSearchEnabled(false);
    }
  }, [zkMode]);

  // Fetch smart search status on first input focus (not on mount)
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
          if (!data.semantic_enabled) {
            setSmartSearchEnabled(false);
          }
        }
      } catch (error: unknown) {
        console.error('Failed to fetch smart search status:', error);
      }
    };
    fetchSmartSearchStatus();
  };

  // Fetch autocomplete suggestions
  const fetchSuggestions = async (searchQuery: string): Promise<void> => {
    if (searchQuery.length < 2) {
      setSuggestions([]);
      return;
    }

    // For ZK mode, generate suggestions from local file list
    if (zkMode) {
      const searchLower = searchQuery.toLowerCase();
      const matchedNames = files
        .filter((f: FileItem) => {
          const name = (f.name || '').toLowerCase();
          return name.includes(searchLower);
        })
        .map((f: FileItem) => f.name)
        .slice(0, 5);

      setSuggestions(matchedNames);
      return;
    }

    try {
      const response = await fetch(
        `${API_URL}/api/v1/search/autocomplete?q=${encodeURIComponent(searchQuery)}`,
        {
          credentials: 'include',
        }
      );

      if (response.ok) {
        const data = (await response.json()) as { suggestions?: string[] };
        setSuggestions(data.suggestions || []);
      }
    } catch (error: unknown) {
      console.error('Autocomplete failed:', error);
    }
  };

  // Debounced autocomplete
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const value = e.target.value;
    setQuery(value);
    setShowSuggestions(true);

    // Clear previous timer
    if (debounceTimer.current) {
      clearTimeout(debounceTimer.current);
    }

    // Set new timer
    debounceTimer.current = setTimeout(() => {
      fetchSuggestions(value);
    }, 300);
  };

  const handleSearch = async (searchQuery: string = query): Promise<void> => {
    if (!searchQuery.trim()) return;

    setLoading(true);
    setShowSuggestions(false);

    try {
      // For ZK users, perform client-side search
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
            (mimeType.includes('document') || mimeType.includes('pdf') || mimeType.includes('text'))
          )
            return true;

          return false;
        });

        const results: SearchResults = {
          files: {
            hits: matchedFiles.map((f: FileItem): SearchHit => ({
              id: f.id,
              name: f.name,
              size: f.size ?? undefined,
              mime_type: f.mime_type ?? undefined,
              created_at: f.created_at ?? undefined,
              is_encrypted: true,
              score: 1.0,
            })),
            total: matchedFiles.length,
          },
          mode: 'client-side' as const,
          semantic_enabled: false,
          zk_mode: true,
        };

        onSearch(results);
        return;
      }

      // Use smart search endpoint if enabled
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
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'include',
        body: JSON.stringify(requestBody),
      });

      if (response.ok) {
        const data = (await response.json()) as Record<string, unknown>;

        let results: SearchResults;
        if (smartSearchEnabled) {
          const dataResults = Array.isArray(data.results) ? data.results as SearchHit[] : [];
          const dataTotal = typeof data.total === 'number' ? data.total : 0;
          const dataMode = typeof data.mode === 'string' ? (data.mode as SearchMode) : undefined;
          const dataSemanticEnabled = typeof data.semantic_enabled === 'boolean' ? data.semantic_enabled : undefined;
          
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
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (debounceTimer.current) {
        clearTimeout(debounceTimer.current);
      }
    };
  }, []);

  const handleSuggestionClick = (suggestion: string): void => {
    setQuery(suggestion);
    setShowSuggestions(false);
    handleSearch(suggestion);
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

  return (
    <div className="relative" ref={searchRef}>
      {/* Search Input */}
      <div className="relative">
        <div
          className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border ${
            darkMode
              ? 'bg-gray-800 border-gray-700 text-white'
              : 'bg-white border-gray-300 text-gray-900'
          }`}
        >
          <Search size={20} className="text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            onFocus={handleSearchFocus}
            placeholder="Search files and folders..."
            className={`flex-1 bg-transparent outline-none ${
              darkMode ? 'placeholder-gray-500' : 'placeholder-gray-400'
            }`}
          />

          {loading && <Loader2 size={20} className="text-blue-500 animate-spin" />}

          {query && (
            <button
              onClick={clearSearch}
              className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
            >
              <X size={18} className="text-gray-400" />
            </button>
          )}

          {/* ZK Mode Indicator or Smart Search Toggle */}
          {zkMode ? (
            <div
              className="p-1.5 rounded bg-green-500 text-white flex items-center gap-1"
              title="Zero-Knowledge Mode: Searching encrypted files locally"
            >
              <Lock size={16} />
              <span className="text-xs font-medium hidden sm:inline">ZK</span>
            </div>
          ) : (
            <button
              onClick={() => setSmartSearchEnabled(!smartSearchEnabled)}
              className={`p-1.5 rounded transition-colors flex items-center gap-1 ${
                smartSearchEnabled
                  ? 'bg-purple-500 text-white'
                  : darkMode
                    ? 'hover:bg-gray-700 text-gray-400'
                    : 'hover:bg-gray-200 text-gray-600'
              }`}
              title={
                smartSearchEnabled
                  ? 'AI Smart Search enabled (click to disable)'
                  : 'Enable AI Smart Search'
              }
              disabled={smartSearchStatus === null || !smartSearchStatus.semantic_enabled}
            >
              <Sparkles size={16} />
              {smartSearchEnabled && (
                <span className="text-xs font-medium hidden sm:inline">AI</span>
              )}
            </button>
          )}

          {/* Hide advanced filters in ZK mode */}
          {!zkMode && (
            <button
              onClick={() => setShowFilters(!showFilters)}
              className={`p-1.5 rounded transition-colors ${
                showFilters
                  ? 'bg-blue-500 text-white'
                  : darkMode
                    ? 'hover:bg-gray-700 text-gray-400'
                    : 'hover:bg-gray-200 text-gray-600'
              }`}
              title="Filters"
            >
              <Filter size={18} />
            </button>
          )}
        </div>

        {/* Autocomplete Suggestions */}
        {showSuggestions && suggestions.length > 0 && (
          <div
            className={`absolute z-50 w-full mt-1 rounded-lg shadow-lg border ${
              darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
            }`}
          >
            {suggestions.map((suggestion, index) => (
              <div
                key={index}
                onClick={() => handleSuggestionClick(suggestion)}
                className={`px-4 py-2 cursor-pointer transition-colors ${
                  darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <Search size={14} className="text-gray-400" />
                  <span className="text-sm">{suggestion}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Filters Panel */}
      {showFilters && (
        <div
          className={`absolute z-40 w-full mt-2 p-4 rounded-lg shadow-lg border ${
            darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
          }`}
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Search Filters
            </h3>
            <button onClick={clearFilters} className="text-sm text-blue-500 hover:underline">
              Clear All
            </button>
          </div>

          {/* Smart Search Mode Selector */}
          {smartSearchEnabled && smartSearchStatus?.semantic_enabled && (
            <div className={`mb-4 p-3 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-purple-50'}`}>
              <div className="flex items-center gap-2 mb-2">
                <Sparkles size={16} className="text-purple-500" />
                <span
                  className={`text-sm font-medium ${darkMode ? 'text-purple-300' : 'text-purple-700'}`}
                >
                  AI Search Mode
                </span>
                {smartSearchStatus?.coverage_percent !== undefined && (
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full ${darkMode ? 'bg-gray-600 text-gray-300' : 'bg-purple-100 text-purple-600'}`}
                  >
                    {smartSearchStatus.coverage_percent}% indexed
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => setSearchMode('hybrid')}
                  className={`flex-1 px-3 py-1.5 text-xs rounded transition-colors ${
                    searchMode === 'hybrid'
                      ? 'bg-purple-500 text-white'
                      : darkMode
                        ? 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                        : 'bg-white text-gray-700 hover:bg-gray-100'
                  }`}
                  title="Best of both: combines keyword and semantic search"
                >
                  <Zap size={12} className="inline mr-1" />
                  Hybrid
                </button>
                <button
                  onClick={() => setSearchMode('semantic')}
                  className={`flex-1 px-3 py-1.5 text-xs rounded transition-colors ${
                    searchMode === 'semantic'
                      ? 'bg-purple-500 text-white'
                      : darkMode
                        ? 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                        : 'bg-white text-gray-700 hover:bg-gray-100'
                  }`}
                  title="Find files by meaning (e.g., 'vacation photos')"
                >
                  <Sparkles size={12} className="inline mr-1" />
                  Semantic
                </button>
                <button
                  onClick={() => setSearchMode('keyword')}
                  className={`flex-1 px-3 py-1.5 text-xs rounded transition-colors ${
                    searchMode === 'keyword'
                      ? 'bg-purple-500 text-white'
                      : darkMode
                        ? 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                        : 'bg-white text-gray-700 hover:bg-gray-100'
                  }`}
                  title="Traditional exact keyword matching"
                >
                  <Search size={12} className="inline mr-1" />
                  Keyword
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4">
            {/* File Type */}
            <div>
              <label
                className={`block text-sm font-medium mb-1 ${
                  darkMode ? 'text-gray-300' : 'text-gray-700'
                }`}
              >
                File Type
              </label>
              <select
                value={filters.mime_type}
                onChange={(e) => setFilters({ ...filters, mime_type: e.target.value })}
                className={`w-full px-3 py-2 rounded border text-sm ${
                  darkMode
                    ? 'bg-gray-700 border-gray-600 text-white'
                    : 'bg-white border-gray-300 text-gray-900'
                }`}
              >
                <option value="">All Types</option>
                <option value="image/jpeg">JPEG Images</option>
                <option value="image/png">PNG Images</option>
                <option value="application/pdf">PDF Documents</option>
                <option value="video/mp4">MP4 Videos</option>
                <option value="video/quicktime">MOV Videos</option>
                <option value="application/zip">ZIP Archives</option>
                <option value="text/plain">Text Files</option>
              </select>
            </div>

            {/* Storage Tier */}
            <div>
              <label
                className={`block text-sm font-medium mb-1 ${
                  darkMode ? 'text-gray-300' : 'text-gray-700'
                }`}
              >
                Storage Tier
              </label>
              <select
                value={filters.storage_tier}
                onChange={(e) => setFilters({ ...filters, storage_tier: e.target.value })}
                className={`w-full px-3 py-2 rounded border text-sm ${
                  darkMode
                    ? 'bg-gray-700 border-gray-600 text-white'
                    : 'bg-white border-gray-300 text-gray-900'
                }`}
              >
                <option value="">All Tiers</option>
                <option value="cache">Cache</option>
                <option value="warm">Warm</option>
                <option value="cold">Cold</option>
              </select>
            </div>

            {/* Size Range */}
            <div>
              <label
                className={`block text-sm font-medium mb-1 ${
                  darkMode ? 'text-gray-300' : 'text-gray-700'
                }`}
              >
                Min Size (MB)
              </label>
              <input
                type="number"
                value={typeof filters.size_min === 'number' ? filters.size_min / 1048576 : ''}
                onChange={(e) =>
                  setFilters({
                    ...filters,
                    size_min: e.target.value ? parseInt(e.target.value) * 1048576 : '',
                  })
                }
                placeholder="0"
                className={`w-full px-3 py-2 rounded border text-sm ${
                  darkMode
                    ? 'bg-gray-700 border-gray-600 text-white'
                    : 'bg-white border-gray-300 text-gray-900'
                }`}
              />
            </div>

            <div>
              <label
                className={`block text-sm font-medium mb-1 ${
                  darkMode ? 'text-gray-300' : 'text-gray-700'
                }`}
              >
                Max Size (MB)
              </label>
              <input
                type="number"
                value={typeof filters.size_max === 'number' ? filters.size_max / 1048576 : ''}
                onChange={(e) =>
                  setFilters({
                    ...filters,
                    size_max: e.target.value ? parseInt(e.target.value) * 1048576 : '',
                  })
                }
                placeholder="1000"
                className={`w-full px-3 py-2 rounded border text-sm ${
                  darkMode
                    ? 'bg-gray-700 border-gray-600 text-white'
                    : 'bg-white border-gray-300 text-gray-900'
                }`}
              />
            </div>

            {/* Date Range */}
            <div>
              <label
                className={`block text-sm font-medium mb-1 ${
                  darkMode ? 'text-gray-300' : 'text-gray-700'
                }`}
              >
                From Date
              </label>
              <input
                type="date"
                value={filters.date_from}
                onChange={(e) => setFilters({ ...filters, date_from: e.target.value })}
                className={`w-full px-3 py-2 rounded border text-sm ${
                  darkMode
                    ? 'bg-gray-700 border-gray-600 text-white'
                    : 'bg-white border-gray-300 text-gray-900'
                }`}
              />
            </div>

            <div>
              <label
                className={`block text-sm font-medium mb-1 ${
                  darkMode ? 'text-gray-300' : 'text-gray-700'
                }`}
              >
                To Date
              </label>
              <input
                type="date"
                value={filters.date_to}
                onChange={(e) => setFilters({ ...filters, date_to: e.target.value })}
                className={`w-full px-3 py-2 rounded border text-sm ${
                  darkMode
                    ? 'bg-gray-700 border-gray-600 text-white'
                    : 'bg-white border-gray-300 text-gray-900'
                }`}
              />
            </div>
          </div>

          <button
            onClick={() => handleSearch()}
            className="w-full mt-4 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
          >
            Apply Filters
          </button>
        </div>
      )}
    </div>
  );
};

export default SearchBar;
