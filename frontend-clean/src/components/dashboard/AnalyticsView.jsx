import React, { useState, useEffect } from 'react';
import {
  BarChart3,
  TrendingUp,
  HardDrive,
  FileText,
  Image,
  Video,
  Music,
  Archive,
  Code,
  Loader,
  Download,
  Upload as UploadIcon,
  Target,
  Sparkles,
  Brain
} from 'lucide-react';

export default function AnalyticsView({ darkMode, storageStats }) {
  const [analytics, setAnalytics] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Simulate loading analytics data
    // In production, this would fetch from API
    setTimeout(() => {
      setAnalytics({
        fileTypeDistribution: [
          { type: 'Documents', count: 145, size: 512 * 1024 * 1024, icon: FileText, color: '#3b82f6' },
          { type: 'Images', count: 89, size: 2.1 * 1024 * 1024 * 1024, icon: Image, color: '#10b981' },
          { type: 'Videos', count: 23, size: 5.6 * 1024 * 1024 * 1024, icon: Video, color: '#f59e0b' },
          { type: 'Audio', count: 67, size: 890 * 1024 * 1024, icon: Music, color: '#8b5cf6' },
          { type: 'Archives', count: 34, size: 1.2 * 1024 * 1024 * 1024, icon: Archive, color: '#ef4444' },
          { type: 'Code', count: 201, size: 256 * 1024 * 1024, icon: Code, color: '#06b6d4' },
        ],
        uploadTrend: [
          { month: 'Jan', uploads: 45, downloads: 67 },
          { month: 'Feb', uploads: 52, downloads: 73 },
          { month: 'Mar', uploads: 78, downloads: 91 },
          { month: 'Apr', uploads: 89, downloads: 102 },
          { month: 'May', uploads: 94, downloads: 115 },
          { month: 'Jun', uploads: 107, downloads: 128 },
        ],
        mlInsights: [
          { feature: 'Quota Alerts', status: 'Active', predictions: 12, accuracy: 89 },
          { feature: 'Storage Optimization', status: 'Active', savings: '2.3 GB', recommendations: 8 },
          { feature: 'Auto-Organization', status: 'Active', filesOrganized: 145, clusters: 5 },
          { feature: 'Recommendations', status: 'Active', suggested: 34, accepted: 21 },
        ]
      });
      setLoading(false);
    }, 1000);
  }, []);

  const formatBytes = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader className="animate-spin text-blue-500" size={48} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <div className="flex items-center gap-3 mb-2">
          <BarChart3 size={24} className="text-[#0033A0]" />
          <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            Analytics Dashboard
          </h1>
        </div>
        <p className={`${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
          Insights into your storage usage and AI feature performance
        </p>
      </div>

      {/* File Type Distribution */}
      <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <h2 className={`text-lg font-semibold mb-4 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          File Type Distribution
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {analytics.fileTypeDistribution.map((item) => {
            const Icon = item.icon;
            return (
              <div
                key={item.type}
                className={`p-4 rounded-lg border ${darkMode ? 'border-gray-700 bg-gray-750' : 'border-gray-200'}`}
              >
                <div className="flex items-center gap-3 mb-3">
                  <div className="p-2 rounded-lg" style={{ backgroundColor: item.color + '20' }}>
                    <Icon size={20} style={{ color: item.color }} />
                  </div>
                  <span className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    {item.type}
                  </span>
                </div>
                <div className="space-y-1">
                  <div className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                    {item.count} files
                  </div>
                  <div className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    {formatBytes(item.size)}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Upload/Download Trend */}
      <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <h2 className={`text-lg font-semibold mb-4 flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          <TrendingUp size={20} />
          Activity Trend (Last 6 Months)
        </h2>
        <div className="space-y-4">
          {analytics.uploadTrend.map((month) => (
            <div key={month.month} className="space-y-2">
              <div className="flex items-center justify-between">
                <span className={`text-sm font-medium ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                  {month.month}
                </span>
                <div className="flex items-center gap-4 text-sm">
                  <span className="flex items-center gap-1 text-blue-500">
                    <UploadIcon size={14} />
                    {month.uploads}
                  </span>
                  <span className="flex items-center gap-1 text-green-500">
                    <Download size={14} />
                    {month.downloads}
                  </span>
                </div>
              </div>
              <div className="flex gap-2">
                <div
                  className="h-2 rounded-full bg-blue-500"
                  style={{ width: `${(month.uploads / 150) * 100}%` }}
                />
                <div
                  className="h-2 rounded-full bg-green-500"
                  style={{ width: `${(month.downloads / 150) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* ML Features Performance */}
      <div className={`rounded-lg p-6 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
        <h2 className={`text-lg font-semibold mb-4 flex items-center gap-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          <Brain size={20} />
          AI Features Performance
        </h2>
        <div className="space-y-4">
          {analytics.mlInsights.map((insight, index) => {
            const icons = [Target, Sparkles, BarChart3, Brain];
            const Icon = icons[index];
            return (
              <div
                key={insight.feature}
                className={`p-4 rounded-lg border ${darkMode ? 'border-gray-700 bg-gray-750' : 'border-gray-200'}`}
              >
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <Icon size={20} className="text-[#0033A0]" />
                    <span className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                      {insight.feature}
                    </span>
                  </div>
                  <span className="px-2 py-1 bg-green-100 text-green-700 text-xs font-medium rounded">
                    {insight.status}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  {insight.predictions && (
                    <div>
                      <div className={darkMode ? 'text-gray-400' : 'text-gray-500'}>Predictions</div>
                      <div className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                        {insight.predictions}
                      </div>
                    </div>
                  )}
                  {insight.accuracy && (
                    <div>
                      <div className={darkMode ? 'text-gray-400' : 'text-gray-500'}>Accuracy</div>
                      <div className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                        {insight.accuracy}%
                      </div>
                    </div>
                  )}
                  {insight.savings && (
                    <div>
                      <div className={darkMode ? 'text-gray-400' : 'text-gray-500'}>Savings</div>
                      <div className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                        {insight.savings}
                      </div>
                    </div>
                  )}
                  {insight.recommendations && (
                    <div>
                      <div className={darkMode ? 'text-gray-400' : 'text-gray-500'}>Recommendations</div>
                      <div className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                        {insight.recommendations}
                      </div>
                    </div>
                  )}
                  {insight.filesOrganized && (
                    <div>
                      <div className={darkMode ? 'text-gray-400' : 'text-gray-500'}>Files Organized</div>
                      <div className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                        {insight.filesOrganized}
                      </div>
                    </div>
                  )}
                  {insight.clusters && (
                    <div>
                      <div className={darkMode ? 'text-gray-400' : 'text-gray-500'}>Clusters</div>
                      <div className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                        {insight.clusters}
                      </div>
                    </div>
                  )}
                  {insight.suggested && (
                    <div>
                      <div className={darkMode ? 'text-gray-400' : 'text-gray-500'}>Suggested</div>
                      <div className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                        {insight.suggested}
                      </div>
                    </div>
                  )}
                  {insight.accepted && (
                    <div>
                      <div className={darkMode ? 'text-gray-400' : 'text-gray-500'}>Accepted</div>
                      <div className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                        {insight.accepted}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
