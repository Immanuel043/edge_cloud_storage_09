import React from 'react';
import { Cloud, HardDrive } from 'lucide-react';
import { formatBytes } from '../../utils/helpers';

export default function StorageStats({ stats, darkMode }) {
  if (!stats) return null;

  return (
    <div className={`mb-6 p-4 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
      <h2 className={`text-lg font-semibold mb-3 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
        Storage Usage
      </h2>
      <div className="mb-2">
        <div className="flex justify-between text-sm mb-1">
          <span className={darkMode ? 'text-gray-400' : 'text-gray-600'}>
            {formatBytes(stats.used)} of {formatBytes(stats.quota)} used
          </span>
          <span className={darkMode ? 'text-gray-400' : 'text-gray-600'}>
            {stats.percentage_used?.toFixed(1)}%
          </span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2">
          <div
            className="bg-blue-500 h-2 rounded-full transition-all"
            style={{ width: `${stats.percentage_used}%` }}
          />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-4 mt-4">
        <div className="text-center">
          <Cloud className={`mx-auto mb-1 ${darkMode ? 'text-blue-400' : 'text-blue-500'}`} size={20} />
          <div className="text-xs text-gray-500">Cache</div>
          <div className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            {formatBytes(stats.distribution?.cache?.size || 0)}
          </div>
        </div>
        <div className="text-center">
          <HardDrive className={`mx-auto mb-1 ${darkMode ? 'text-green-400' : 'text-green-500'}`} size={20} />
          <div className="text-xs text-gray-500">Warm</div>
          <div className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            {formatBytes(stats.distribution?.warm?.size || 0)}
          </div>
        </div>
        <div className="text-center">
          <HardDrive className={`mx-auto mb-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`} size={20} />
          <div className="text-xs text-gray-500">Cold</div>
          <div className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            {formatBytes(stats.distribution?.cold?.size || 0)}
          </div>
        </div>
      </div>
    </div>
  );
}