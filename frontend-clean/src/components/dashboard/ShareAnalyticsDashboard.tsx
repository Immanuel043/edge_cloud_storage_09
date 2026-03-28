import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Activity, Eye, Download, Users, Globe, TrendingUp,
  Loader, AlertCircle, RefreshCw, FileIcon,
  FolderIcon, Package,
} from 'lucide-react';
import { storageService } from '../../services/storageService';

interface AnalyticsSummary {
  total_shares: number;
  active_shares: number;
  total_views: number;
  total_downloads: number;
  total_unique_ips: number;
  most_viewed_share?: { id: string; name: string; type: string; views: number };
  most_downloaded_share?: { id: string; name: string; type: string; downloads: number };
}

interface DailyStats {
  date: string;
  views: number;
  downloads: number;
}

interface TrendsData {
  daily: DailyStats[];
  period_days: number;
}

interface TopItem {
  id: string;
  name: string;
  share_type: string;
  item_type: string;
  views: number;
  downloads: number;
  unique_ips: number;
  is_active: boolean;
  created_at: string;
  last_accessed?: string;
}

interface TopItemsData {
  items: TopItem[];
  total: number;
}

interface ShareAnalyticsDashboardProps {
  darkMode: boolean;
}

const ShareAnalyticsDashboard: React.FC<ShareAnalyticsDashboardProps> = ({ darkMode }) => {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [trends, setTrends] = useState<TrendsData | null>(null);
  const [topItems, setTopItems] = useState<TopItemsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [trendDays, setTrendDays] = useState(30);
  const [sortBy, setSortBy] = useState<'views' | 'downloads'>('views');

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryData, trendsData, topData] = await Promise.all([
        storageService.getShareAnalyticsSummary(),
        storageService.getShareAnalyticsTrends(trendDays),
        storageService.getShareAnalyticsTop(sortBy),
      ]);
      setSummary(summaryData as AnalyticsSummary);
      setTrends(trendsData as TrendsData);
      setTopItems(topData as TopItemsData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load analytics');
    } finally {
      setLoading(false);
    }
  }, [trendDays, sortBy]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const trendMax = useMemo(() => {
    if (!trends) return 1;
    return Math.max(1, ...trends.daily.map((d) => Math.max(d.views, d.downloads)));
  }, [trends]);

  const trendTotals = useMemo(() => {
    if (!trends) return { views: 0, downloads: 0 };
    return trends.daily.reduce(
      (acc, d) => ({ views: acc.views + d.views, downloads: acc.downloads + d.downloads }),
      { views: 0, downloads: 0 },
    );
  }, [trends]);

  const formatDate = (d: string) => {
    const date = new Date(d);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };

  const itemIcon = (type: string) => {
    switch (type) {
      case 'folder': return <FolderIcon size={16} className="text-blue-500" />;
      case 'bundle': return <Package size={16} className="text-purple-500" />;
      default: return <FileIcon size={16} className={darkMode ? 'text-gray-400' : 'text-gray-500'} />;
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <Loader className={`animate-spin mb-4 ${darkMode ? 'text-blue-400' : 'text-blue-500'}`} size={48} />
        <p className={`text-lg ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>Loading share analytics...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <AlertCircle className="text-red-500 mb-4" size={48} />
        <p className={`text-lg font-semibold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>Failed to load analytics</p>
        <p className={`text-sm mb-4 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>{error}</p>
        <button onClick={fetchAll} className="px-4 py-2 rounded-lg bg-blue-500 hover:bg-blue-600 text-white transition-colors">
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-lg ${darkMode ? 'bg-blue-500/10' : 'bg-blue-50'}`}>
            <Activity className={darkMode ? 'text-blue-400' : 'text-blue-500'} size={24} />
          </div>
          <div>
            <h2 className={`text-xl font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Share Analytics
            </h2>
            <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Access insights for your shared content
            </p>
          </div>
        </div>
        <button
          onClick={fetchAll}
          className={`p-2 rounded-lg transition-colors ${darkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'}`}
          title="Refresh"
        >
          <RefreshCw size={18} />
        </button>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          {[
            { label: 'Total Shares', value: summary.total_shares, sub: `${summary.active_shares} active`, icon: Activity, color: 'blue' },
            { label: 'Total Views', value: summary.total_views, icon: Eye, color: 'green' },
            { label: 'Total Downloads', value: summary.total_downloads, icon: Download, color: 'purple' },
            { label: 'Unique Visitors', value: summary.total_unique_ips, icon: Globe, color: 'orange' },
            { label: 'Active Shares', value: summary.active_shares, icon: TrendingUp, color: 'teal' },
          ].map((card) => (
            <div
              key={card.label}
              className={`rounded-xl p-4 ${darkMode ? 'bg-gray-800 border border-gray-700' : 'bg-white border border-gray-200 shadow-sm'}`}
            >
              <div className="flex items-center justify-between mb-2">
                <card.icon size={18} className={`text-${card.color}-500`} />
                <span className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>{card.label}</span>
              </div>
              <p className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                {card.value.toLocaleString()}
              </p>
              {card.sub && (
                <p className={`text-xs mt-1 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>{card.sub}</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Highlight Cards */}
      {summary && (summary.most_viewed_share || summary.most_downloaded_share) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {summary.most_viewed_share && (
            <div className={`rounded-xl p-4 ${darkMode ? 'bg-green-900/20 border border-green-800/30' : 'bg-green-50 border border-green-200'}`}>
              <p className={`text-xs font-medium mb-1 ${darkMode ? 'text-green-400' : 'text-green-600'}`}>Most Viewed</p>
              <div className="flex items-center gap-2">
                {itemIcon(summary.most_viewed_share.type)}
                <p className={`font-medium truncate ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  {summary.most_viewed_share.name}
                </p>
              </div>
              <p className={`text-sm mt-1 ${darkMode ? 'text-green-300' : 'text-green-700'}`}>
                {summary.most_viewed_share.views.toLocaleString()} views
              </p>
            </div>
          )}
          {summary.most_downloaded_share && (
            <div className={`rounded-xl p-4 ${darkMode ? 'bg-purple-900/20 border border-purple-800/30' : 'bg-purple-50 border border-purple-200'}`}>
              <p className={`text-xs font-medium mb-1 ${darkMode ? 'text-purple-400' : 'text-purple-600'}`}>Most Downloaded</p>
              <div className="flex items-center gap-2">
                {itemIcon(summary.most_downloaded_share.type)}
                <p className={`font-medium truncate ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  {summary.most_downloaded_share.name}
                </p>
              </div>
              <p className={`text-sm mt-1 ${darkMode ? 'text-purple-300' : 'text-purple-700'}`}>
                {summary.most_downloaded_share.downloads.toLocaleString()} downloads
              </p>
            </div>
          )}
        </div>
      )}

      {/* Trends Chart */}
      {trends && (
        <div className={`rounded-xl p-5 ${darkMode ? 'bg-gray-800 border border-gray-700' : 'bg-white border border-gray-200 shadow-sm'}`}>
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>Access Trends</h3>
              <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                {trendTotals.views} views, {trendTotals.downloads} downloads in {trendDays} days
              </p>
            </div>
            <select
              value={trendDays}
              onChange={(e) => setTrendDays(Number(e.target.value))}
              className={`text-sm rounded-lg px-2 py-1 border ${
                darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
              }`}
            >
              <option value={7}>7 days</option>
              <option value={14}>14 days</option>
              <option value={30}>30 days</option>
              <option value={60}>60 days</option>
              <option value={90}>90 days</option>
            </select>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4 mb-3">
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full bg-blue-500" />
              <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Views</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-3 h-3 rounded-full bg-purple-500" />
              <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Downloads</span>
            </div>
          </div>

          {/* Bar Chart */}
          <div className="flex items-end gap-[2px] h-40">
            {trends.daily.map((day, i) => {
              const viewH = (day.views / trendMax) * 100;
              const dlH = (day.downloads / trendMax) * 100;
              const showLabel = trends.daily.length <= 14 || i % Math.ceil(trends.daily.length / 14) === 0;
              return (
                <div key={day.date} className="flex-1 flex flex-col items-center gap-0 min-w-0" title={`${formatDate(day.date)}: ${day.views} views, ${day.downloads} downloads`}>
                  <div className="w-full flex gap-[1px] items-end" style={{ height: '140px' }}>
                    <div className="flex-1 bg-blue-500 rounded-t-sm transition-all" style={{ height: `${Math.max(viewH, day.views > 0 ? 2 : 0)}%` }} />
                    <div className="flex-1 bg-purple-500 rounded-t-sm transition-all" style={{ height: `${Math.max(dlH, day.downloads > 0 ? 2 : 0)}%` }} />
                  </div>
                  {showLabel && (
                    <span className={`text-[9px] mt-1 truncate w-full text-center ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                      {formatDate(day.date)}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Top Shares Table */}
      {topItems && topItems.items.length > 0 && (
        <div className={`rounded-xl p-5 ${darkMode ? 'bg-gray-800 border border-gray-700' : 'bg-white border border-gray-200 shadow-sm'}`}>
          <div className="flex items-center justify-between mb-4">
            <h3 className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>Top Shares</h3>
            <div className="flex items-center gap-2">
              <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>Sort by:</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as 'views' | 'downloads')}
                className={`text-sm rounded-lg px-2 py-1 border ${
                  darkMode ? 'bg-gray-700 border-gray-600 text-white' : 'bg-white border-gray-300 text-gray-900'
                }`}
              >
                <option value="views">Views</option>
                <option value="downloads">Downloads</option>
              </select>
            </div>
          </div>

          <div className="space-y-2">
            {topItems.items.map((item, idx) => {
              const maxVal = Math.max(1, topItems.items[0]?.[sortBy] ?? 1);
              const barWidth = (item[sortBy] / maxVal) * 100;
              return (
                <div
                  key={item.id}
                  className={`flex items-center gap-3 p-3 rounded-lg ${
                    darkMode ? 'hover:bg-gray-700/50' : 'hover:bg-gray-50'
                  }`}
                >
                  <span className={`text-xs font-mono w-5 text-right ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                    {idx + 1}
                  </span>
                  {itemIcon(item.item_type)}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className={`text-sm font-medium truncate ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                        {item.name}
                      </p>
                      {!item.is_active && (
                        <span className="text-xs text-red-400 flex-shrink-0">inactive</span>
                      )}
                      <span className={`text-xs flex-shrink-0 ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
                        {item.share_type}
                      </span>
                    </div>
                    {/* Mini bar */}
                    <div className={`h-1.5 rounded-full mt-1.5 ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                      <div
                        className={`h-full rounded-full ${sortBy === 'views' ? 'bg-blue-500' : 'bg-purple-500'}`}
                        style={{ width: `${barWidth}%` }}
                      />
                    </div>
                  </div>
                  <div className="flex items-center gap-4 flex-shrink-0 text-xs">
                    <div className="text-right">
                      <span className={`flex items-center gap-1 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Eye size={12} /> {item.views.toLocaleString()}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className={`flex items-center gap-1 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                        <Download size={12} /> {item.downloads.toLocaleString()}
                      </span>
                    </div>
                    <div className="text-right">
                      <span className={`flex items-center gap-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                        <Users size={12} /> {item.unique_ips}
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Empty state */}
      {summary && summary.total_shares === 0 && (
        <div className="flex flex-col items-center justify-center py-16">
          <div className={`p-6 rounded-2xl mb-4 ${darkMode ? 'bg-blue-500/10' : 'bg-blue-50'}`}>
            <Activity className={darkMode ? 'text-blue-400' : 'text-blue-500'} size={48} />
          </div>
          <p className={`text-lg font-semibold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            No sharing activity yet
          </p>
          <p className={`text-sm text-center max-w-md ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
            Share files, folders, or bundles to start seeing access analytics here.
          </p>
        </div>
      )}
    </div>
  );
};

export default ShareAnalyticsDashboard;
