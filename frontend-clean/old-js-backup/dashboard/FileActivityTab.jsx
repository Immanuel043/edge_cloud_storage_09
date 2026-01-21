import React, { useState, useEffect } from 'react';
import {
  Upload, Edit, Download, Share2, Eye, User, Clock, CheckCircle, Loader, AlertCircle, Edit2, Trash2
} from 'lucide-react';
import { formatDate } from '../../utils/helpers';
import { storageService } from '../../services/storageService';

export default function FileActivityTab({ file, darkMode }) {
  const [activities, setActivities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetchActivity();
  }, [file.id]);

  const fetchActivity = async () => {
    try {
      setLoading(true);
      setError(null);
      const data = await storageService.getFileActivity(file.id);
      setActivities(data);
    } catch (err) {
      console.error('Failed to fetch activity:', err);
      setError(err.message || 'Failed to load activity');
    } finally {
      setLoading(false);
    }
  };

  const getActionIcon = (action) => {
    const iconMap = {
      file_uploaded: Upload,
      file_modified: Edit,
      file_downloaded: Download,
      file_shared: Share2,
      file_viewed: Eye,
      file_renamed: Edit2,
      file_deleted: Trash2,
    };
    return iconMap[action] || Upload;
  };

  const getActionColor = (action) => {
    const colorMap = {
      file_uploaded: 'blue',
      file_modified: 'amber',
      file_downloaded: 'green',
      file_shared: 'purple',
      file_viewed: 'cyan',
      file_renamed: 'amber',
      file_deleted: 'red',
    };
    return colorMap[action] || 'gray';
  };

  const getIconColor = (color) => {
    const colors = {
      blue: 'text-blue-500',
      amber: 'text-amber-500',
      green: 'text-green-500',
      purple: 'text-purple-500',
      cyan: 'text-cyan-500',
      pink: 'text-pink-500',
      red: 'text-red-500',
    };
    return colors[color] || 'text-gray-500';
  };

  const getBackgroundColor = (color) => {
    const colors = {
      blue: darkMode ? 'bg-blue-500/10' : 'bg-blue-50',
      amber: darkMode ? 'bg-amber-500/10' : 'bg-amber-50',
      green: darkMode ? 'bg-green-500/10' : 'bg-green-50',
      purple: darkMode ? 'bg-purple-500/10' : 'bg-purple-50',
      cyan: darkMode ? 'bg-cyan-500/10' : 'bg-cyan-50',
      pink: darkMode ? 'bg-pink-500/10' : 'bg-pink-50',
      red: darkMode ? 'bg-red-500/10' : 'bg-red-50',
    };
    return colors[color] || (darkMode ? 'bg-gray-700' : 'bg-gray-50');
  };

  const getActionText = (activity) => {
    const action = activity.action;
    const metadata = activity.metadata || {};

    switch (action) {
      case 'file_uploaded':
        return 'Uploaded this file';
      case 'file_modified':
        return 'Modified this file';
      case 'file_downloaded':
        return 'Downloaded this file';
      case 'file_shared':
        return 'Shared this file';
      case 'file_viewed':
        return 'Viewed this file';
      case 'file_renamed':
        return `Renamed from "${metadata.old_name}" to "${metadata.new_name}"`;
      case 'file_deleted':
        return 'Deleted this file';
      default:
        return action.replace(/_/g, ' ');
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <Loader className={`animate-spin mb-4 ${darkMode ? 'text-blue-400' : 'text-blue-500'}`} size={48} />
        <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          Loading activity...
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <AlertCircle className="text-red-500 mb-4" size={48} />
        <p className={`text-sm mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          Failed to load activity
        </p>
        <p className={`text-xs mb-4 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          {error}
        </p>
        <button
          onClick={fetchActivity}
          className={`px-4 py-2 text-sm rounded-lg transition-colors ${
            darkMode
              ? 'bg-blue-600 hover:bg-blue-700 text-white'
              : 'bg-blue-500 hover:bg-blue-600 text-white'
          }`}
        >
          Try Again
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Activity Timeline */}
      <div className="space-y-4">
        {activities.length > 0 ? (
          activities.map((activity, index) => {
            const Icon = getActionIcon(activity.action);
            const color = getActionColor(activity.action);

            return (
              <div key={activity.id} className="flex gap-4">
                {/* Timeline line */}
                <div className="flex flex-col items-center">
                  <div className={`p-2 rounded-lg ${getBackgroundColor(color)}`}>
                    <Icon size={16} className={getIconColor(color)} />
                  </div>
                  {index < activities.length - 1 && (
                    <div className={`w-0.5 flex-1 my-1 ${
                      darkMode ? 'bg-gray-700' : 'bg-gray-200'
                    }`} style={{ minHeight: '20px' }}></div>
                  )}
                </div>

                {/* Activity details */}
                <div className="flex-1 pb-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <p className={`text-sm font-medium mb-1 ${
                        darkMode ? 'text-white' : 'text-gray-900'
                      }`}>
                        {getActionText(activity)}
                      </p>
                      <div className={`flex items-center gap-2 text-xs ${
                        darkMode ? 'text-gray-400' : 'text-gray-600'
                      }`}>
                        <Clock size={12} />
                        <span>{formatDate(activity.created_at)}</span>
                        {activity.ip_address && (
                          <>
                            <span>•</span>
                            <span>{activity.ip_address}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })
        ) : (
          <div className="text-center py-12">
            <Clock className={`mx-auto mb-3 ${
              darkMode ? 'text-gray-600' : 'text-gray-400'
            }`} size={48} />
            <p className={`text-sm ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
              No activity recorded yet
            </p>
          </div>
        )}
      </div>

      {/* Activity Summary */}
      {activities.length > 0 && (
        <div className={`p-4 rounded-lg border ${
          darkMode
            ? 'bg-gray-700/30 border-gray-700'
            : 'bg-gray-50 border-gray-200'
        }`}>
          <div className="flex items-center gap-2 mb-3">
            <CheckCircle size={16} className={darkMode ? 'text-green-400' : 'text-green-500'} />
            <h4 className={`text-sm font-semibold ${
              darkMode ? 'text-white' : 'text-gray-900'
            }`}>
              Activity Summary
            </h4>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className={`text-xs mb-1 ${
                darkMode ? 'text-gray-400' : 'text-gray-600'
              }`}>
                Total Activities
              </p>
              <p className={`text-lg font-semibold ${
                darkMode ? 'text-white' : 'text-gray-900'
              }`}>
                {activities.length}
              </p>
            </div>
            <div>
              <p className={`text-xs mb-1 ${
                darkMode ? 'text-gray-400' : 'text-gray-600'
              }`}>
                Last Activity
              </p>
              <p className={`text-xs font-medium ${
                darkMode ? 'text-white' : 'text-gray-900'
              }`}>
                {formatDate(activities[0]?.created_at)}
              </p>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
