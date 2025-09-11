import React, { useState, useEffect } from 'react';
import { 
  Database, 
  HardDrive, 
  TrendingUp,
  RefreshCw,
  Info,
  Zap,
  Package,
  BarChart3,
  Trash2
} from 'lucide-react';
import { formatBytes } from '../../utils/helpers';
import { storageService } from '../../services/storageService';

const DeduplicationPanel = ({ darkMode, token, onOptimizeFile }) => {
  const [analytics, setAnalytics] = useState(null);
  const [savings, setSavings] = useState(null);
  const [loading, setLoading] = useState(true);
  const [optimizing, setOptimizing] = useState(false);

  useEffect(() => {
    fetchData();
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const [analyticsData, savingsData] = await Promise.all([
        storageService.getDedupAnalytics(token),
        storageService.getDedupSavings(token)
      ]);
      setAnalytics(analyticsData);
      setSavings(savingsData);
    } catch (error) {
      console.error('Failed to fetch dedup data:', error);
    } finally {
      setLoading(false);
    }
  };

  const runGarbageCollection = async () => {
    if (!window.confirm('Run garbage collection to clean up unused blocks?')) return;
    
    try {
      await storageService.runGarbageCollection(token);
      await fetchData(); // Refresh stats
      alert('Garbage collection initiated successfully');
    } catch (error) {
      console.error('GC failed:', error);
      alert('Failed to run garbage collection');
    }
  };

  if (loading) {
    return (
      <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'} animate-pulse`}>
        <div className="h-6 bg-gray-300 dark:bg-gray-700 rounded w-1/3 mb-4"></div>
        <div className="space-y-3">
          <div className="h-4 bg-gray-300 dark:bg-gray-700 rounded"></div>
          <div className="h-4 bg-gray-300 dark:bg-gray-700 rounded w-3/4"></div>
        </div>
      </div>
    );
  }

  return (
    <div className={`rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'} p-6`}>
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-2">
          <Zap className="w-6 h-6 text-indigo-500" />
          <h2 className={`text-xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            Deduplication Analytics
          </h2>
        </div>
        <div className="flex gap-2">
          <button
            onClick={runGarbageCollection}
            className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-100 hover:bg-gray-200'} transition-colors`}
            title="Run Garbage Collection"
          >
            <Trash2 size={18} />
          </button>
          <button
            onClick={fetchData}
            disabled={loading}
            className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-100 hover:bg-gray-200'} transition-colors`}
            title="Refresh"
          >
            <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
          </button>
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <div className={`p-4 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-50'}`}>
          <div className="flex items-center justify-between mb-2">
            <Database className="w-4 h-4 text-blue-500" />
            <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              Logical
            </span>
          </div>
          <p className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            {formatBytes(savings?.logical_size || 0)}
          </p>
        </div>
        
        <div className={`p-4 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-50'}`}>
          <div className="flex items-center justify-between mb-2">
            <HardDrive className="w-4 h-4 text-green-500" />
            <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              Physical
            </span>
          </div>
          <p className="text-lg font-semibold text-green-600">
            {formatBytes(savings?.physical_size || 0)}
          </p>
        </div>
        
        <div className={`p-4 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-50'}`}>
          <div className="flex items-center justify-between mb-2">
            <TrendingUp className="w-4 h-4 text-purple-500" />
            <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              Saved
            </span>
          </div>
          <p className="text-lg font-semibold text-purple-600">
            {formatBytes(savings?.saved_size || 0)}
          </p>
        </div>
        
        <div className={`p-4 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-50'}`}>
          <div className="flex items-center justify-between mb-2">
            <Info className="w-4 h-4 text-orange-500" />
            <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              Efficiency
            </span>
          </div>
          <p className="text-lg font-semibold text-orange-600">
            {savings?.storage_efficiency?.toFixed(2)}x
          </p>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="space-y-4">
        <div>
          <div className="flex justify-between mb-2">
            <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Storage Savings
            </span>
            <span className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              {savings?.savings_percentage?.toFixed(1)}%
            </span>
          </div>
          <div className={`w-full h-2 rounded-full ${darkMode ? 'bg-gray-700' : 'bg-gray-200'}`}>
            <div 
              className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-purple-500"
              style={{ width: `${savings?.savings_percentage || 0}%` }}
            />
          </div>
        </div>

        {/* Block Statistics */}
        {analytics?.blocks && (
          <div className={`pt-4 border-t ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
            <div className="flex items-center gap-2 mb-3">
              <Package className="w-4 h-4 text-gray-500" />
              <h4 className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Block Statistics
              </h4>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div className="text-center">
                <p className="text-2xl font-bold text-indigo-600">
                  {analytics.blocks.total_blocks?.toLocaleString() || 0}
                </p>
                <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  Total Blocks
                </p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-green-600">
                  {analytics.blocks.avg_references?.toFixed(1) || 0}
                </p>
                <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  Avg References
                </p>
              </div>
              <div className="text-center">
                <p className="text-2xl font-bold text-purple-600">
                  {analytics.summary?.compression_ratio?.toFixed(2) || 1}x
                </p>
                <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  Compression
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Summary Card */}
        {analytics?.summary && (
          <div className="mt-4 p-4 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-lg text-white">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm opacity-90">Total Files Processed</p>
                <p className="text-2xl font-bold">{analytics.summary.total_files || 0}</p>
              </div>
              <div className="text-right">
                <p className="text-sm opacity-90">Deduplication Ratio</p>
                <p className="text-2xl font-bold">{analytics.summary.dedup_ratio?.toFixed(1) || 0}%</p>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default DeduplicationPanel;