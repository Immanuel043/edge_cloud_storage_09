import React, { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { 
  Database, 
  HardDrive, 
  TrendingUp,
  RefreshCw,
  Info,
  Zap,
  Package,
  BarChart3
} from 'lucide-react';

// Mock service for demonstration
const storageService = {
  getDedupAnalytics: async () => ({
    summary: {
      total_files: 245,
      logical_size: 5368709120,
      physical_size: 3221225472,
      saved_size: 2147483648,
      dedup_ratio: 40.0,
      compression_ratio: 1.67
    },
    blocks: {
      total_blocks: 1250,
      total_size: 5242880000,
      avg_references: 2.3
    },
    top_duplicates: [
      { hash: 'abc123de...', size: 4194304, count: 5 },
      { hash: 'def456gh...', size: 4194304, count: 4 },
      { hash: 'ghi789jk...', size: 4194304, count: 3 }
    ]
  }),
  getDedupSavings: async () => ({
    logical_size: 5368709120,
    physical_size: 3221225472,
    saved_size: 2147483648,
    savings_percentage: 40.0,
    storage_efficiency: 1.67
  })
};

// Helper function
const formatBytes = (bytes) => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const DeduplicationPanel = () => {
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
        storageService.getDedupAnalytics(),
        storageService.getDedupSavings()
      ]);
      setAnalytics(analyticsData);
      setSavings(savingsData);
    } catch (error) {
      console.error('Failed to fetch dedup data:', error);
    } finally {
      setLoading(false);
    }
  };

  const optimizeFile = async (fileId) => {
    setOptimizing(true);
    try {
      const result = await storageService.optimizeFileDedup(fileId);
      if (result.status === 'optimized') {
        await fetchData();
        alert(`Saved ${formatBytes(result.saved_size)}!`);
      }
    } catch (error) {
      console.error('Optimization failed:', error);
    } finally {
      setOptimizing(false);
    }
  };

  if (loading) {
    return (
      <Card className="animate-pulse">
        <CardHeader>
          <div className="h-6 bg-gray-200 rounded w-1/3"></div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="h-4 bg-gray-200 rounded"></div>
            <div className="h-4 bg-gray-200 rounded w-3/4"></div>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="bg-gradient-to-br from-indigo-50 to-purple-50 dark:from-gray-800 dark:to-gray-900">
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Zap className="w-5 h-5 text-indigo-600" />
            Deduplication Analytics
          </div>
          <Button 
            size="sm" 
            variant="outline"
            onClick={fetchData}
            disabled={loading}
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </Button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
          <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <Database className="w-4 h-4 text-blue-500" />
              <span className="text-xs text-gray-500">Logical</span>
            </div>
            <p className="text-lg font-semibold">
              {formatBytes(savings?.logical_size || 0)}
            </p>
          </div>
          
          <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <HardDrive className="w-4 h-4 text-green-500" />
              <span className="text-xs text-gray-500">Physical</span>
            </div>
            <p className="text-lg font-semibold text-green-600">
              {formatBytes(savings?.physical_size || 0)}
            </p>
          </div>
          
          <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <TrendingUp className="w-4 h-4 text-purple-500" />
              <span className="text-xs text-gray-500">Saved</span>
            </div>
            <p className="text-lg font-semibold text-purple-600">
              {formatBytes(savings?.saved_size || 0)}
            </p>
          </div>
          
          <div className="bg-white dark:bg-gray-800 p-4 rounded-lg shadow-sm">
            <div className="flex items-center justify-between mb-2">
              <Info className="w-4 h-4 text-orange-500" />
              <span className="text-xs text-gray-500">Efficiency</span>
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
              <span className="text-sm text-gray-600 dark:text-gray-400">Storage Savings</span>
              <span className="text-sm font-medium">
                {savings?.savings_percentage?.toFixed(1)}%
              </span>
            </div>
            <Progress value={savings?.savings_percentage || 0} className="h-2" />
          </div>

          {/* Block Statistics */}
          {analytics?.blocks && (
            <div className="pt-4 border-t dark:border-gray-700">
              <div className="flex items-center gap-2 mb-3">
                <Package className="w-4 h-4 text-gray-500" />
                <h4 className="text-sm font-medium">Block Statistics</h4>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div className="text-center">
                  <p className="text-2xl font-bold text-indigo-600">
                    {analytics.blocks.total_blocks.toLocaleString()}
                  </p>
                  <p className="text-xs text-gray-500">Total Blocks</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-green-600">
                    {analytics.blocks.avg_references.toFixed(1)}
                  </p>
                  <p className="text-xs text-gray-500">Avg References</p>
                </div>
                <div className="text-center">
                  <p className="text-2xl font-bold text-purple-600">
                    {analytics.summary?.compression_ratio?.toFixed(2)}x
                  </p>
                  <p className="text-xs text-gray-500">Compression</p>
                </div>
              </div>
            </div>
          )}

          {/* Top Duplicates */}
          {analytics?.top_duplicates && analytics.top_duplicates.length > 0 && (
            <div className="pt-4 border-t dark:border-gray-700">
              <div className="flex items-center gap-2 mb-3">
                <BarChart3 className="w-4 h-4 text-gray-500" />
                <h4 className="text-sm font-medium">Most Duplicated Blocks</h4>
              </div>
              <div className="space-y-2">
                {analytics.top_duplicates.slice(0, 3).map((dup, idx) => (
                  <div key={idx} className="flex items-center justify-between p-2 bg-gray-50 dark:bg-gray-800 rounded">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono text-gray-500">
                        {dup.hash}
                      </span>
                      <span className="px-2 py-0.5 text-xs bg-indigo-100 dark:bg-indigo-900 text-indigo-700 dark:text-indigo-300 rounded-full">
                        {dup.count}x
                      </span>
                    </div>
                    <span className="text-sm font-medium text-green-600">
                      {formatBytes(dup.size * (dup.count - 1))} saved
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="pt-4 border-t dark:border-gray-700 flex gap-2">
            <Button 
              variant="outline" 
              size="sm"
              onClick={() => optimizeFile('sample-file-id')}
              disabled={optimizing}
            >
              {optimizing ? 'Optimizing...' : 'Optimize Files'}
            </Button>
            <Button 
              variant="ghost" 
              size="sm"
              onClick={() => console.log('View detailed analytics')}
            >
              View Details
            </Button>
          </div>

          {/* Summary Stats */}
          <div className="mt-4 p-4 bg-gradient-to-r from-indigo-500 to-purple-600 rounded-lg text-white">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm opacity-90">Total Files Processed</p>
                <p className="text-2xl font-bold">{analytics?.summary?.total_files || 0}</p>
              </div>
              <div className="text-right">
                <p className="text-sm opacity-90">Deduplication Ratio</p>
                <p className="text-2xl font-bold">{analytics?.summary?.dedup_ratio?.toFixed(1)}%</p>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default DeduplicationPanel;