import React, { useState, useEffect, useRef } from 'react';
import { Search, X, Filter, Loader2 } from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8001/api/v1';

export default function SearchBar({ onSearch, darkMode }) {
  const [query, setQuery] = useState('');
  const [suggestions, setSuggestions] = useState([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [loading, setLoading] = useState(false);
  const [filters, setFilters] = useState({
    mime_type: '',
    storage_tier: '',
    size_min: '',
    size_max: '',
    date_from: '',
    date_to: ''
  });

  const searchRef = useRef(null);
  const debounceTimer = useRef(null);

  useEffect(() => {
    // Click outside to close suggestions
    const handleClickOutside = (event) => {
      if (searchRef.current && !searchRef.current.contains(event.target)) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Fetch autocomplete suggestions
  const fetchSuggestions = async (searchQuery) => {
    if (searchQuery.length < 2) {
      setSuggestions([]);
      return;
    }

    try {
      const response = await fetch(
        `${API_URL}/search/autocomplete?q=${encodeURIComponent(searchQuery)}`,
        {
          credentials: 'include'
        }
      );

      if (response.ok) {
        const data = await response.json();
        setSuggestions(data.suggestions || []);
      }
    } catch (error) {
      console.error('Autocomplete failed:', error);
    }
  };

  // Debounced autocomplete
  const handleInputChange = (e) => {
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

  const handleSearch = async (searchQuery = query) => {
    if (!searchQuery.trim()) return;

    setLoading(true);
    setShowSuggestions(false);

    try {
      const response = await fetch(`${API_URL}/search/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        body: JSON.stringify({
          query: searchQuery,
          filters: Object.fromEntries(
            Object.entries(filters).filter(([_, v]) => v !== '')
          ),
          size: 50,
          page: 1,
          fuzzy: true
        })
      });

      if (response.ok) {
        const data = await response.json();
        onSearch(data.results);
      }
    } catch (error) {
      console.error('Search failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === 'Enter') {
      handleSearch();
    }
  };

  const handleSuggestionClick = (suggestion) => {
    setQuery(suggestion);
    setShowSuggestions(false);
    handleSearch(suggestion);
  };

  const clearSearch = () => {
    setQuery('');
    setSuggestions([]);
    setShowSuggestions(false);
    onSearch(null); // Clear search results
  };

  const clearFilters = () => {
    setFilters({
      mime_type: '',
      storage_tier: '',
      size_min: '',
      size_max: '',
      date_from: '',
      date_to: ''
    });
  };

  return (
    <div className="relative" ref={searchRef}>
      {/* Search Input */}
      <div className="relative">
        <div className={`flex items-center gap-2 px-4 py-2.5 rounded-lg border ${
          darkMode
            ? 'bg-gray-800 border-gray-700 text-white'
            : 'bg-white border-gray-300 text-gray-900'
        }`}>
          <Search size={20} className="text-gray-400" />
          <input
            type="text"
            value={query}
            onChange={handleInputChange}
            onKeyPress={handleKeyPress}
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
        </div>

        {/* Autocomplete Suggestions */}
        {showSuggestions && suggestions.length > 0 && (
          <div className={`absolute z-50 w-full mt-1 rounded-lg shadow-lg border ${
            darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
          }`}>
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
        <div className={`absolute z-40 w-full mt-2 p-4 rounded-lg shadow-lg border ${
          darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
        }`}>
          <div className="flex items-center justify-between mb-4">
            <h3 className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Search Filters
            </h3>
            <button
              onClick={clearFilters}
              className="text-sm text-blue-500 hover:underline"
            >
              Clear All
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* File Type */}
            <div>
              <label className={`block text-sm font-medium mb-1 ${
                darkMode ? 'text-gray-300' : 'text-gray-700'
              }`}>
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
              <label className={`block text-sm font-medium mb-1 ${
                darkMode ? 'text-gray-300' : 'text-gray-700'
              }`}>
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
              <label className={`block text-sm font-medium mb-1 ${
                darkMode ? 'text-gray-300' : 'text-gray-700'
              }`}>
                Min Size (MB)
              </label>
              <input
                type="number"
                value={filters.size_min}
                onChange={(e) => setFilters({ ...filters, size_min: e.target.value ? parseInt(e.target.value) * 1048576 : '' })}
                placeholder="0"
                className={`w-full px-3 py-2 rounded border text-sm ${
                  darkMode
                    ? 'bg-gray-700 border-gray-600 text-white'
                    : 'bg-white border-gray-300 text-gray-900'
                }`}
              />
            </div>

            <div>
              <label className={`block text-sm font-medium mb-1 ${
                darkMode ? 'text-gray-300' : 'text-gray-700'
              }`}>
                Max Size (MB)
              </label>
              <input
                type="number"
                value={filters.size_max}
                onChange={(e) => setFilters({ ...filters, size_max: e.target.value ? parseInt(e.target.value) * 1048576 : '' })}
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
              <label className={`block text-sm font-medium mb-1 ${
                darkMode ? 'text-gray-300' : 'text-gray-700'
              }`}>
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
              <label className={`block text-sm font-medium mb-1 ${
                darkMode ? 'text-gray-300' : 'text-gray-700'
              }`}>
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
}
