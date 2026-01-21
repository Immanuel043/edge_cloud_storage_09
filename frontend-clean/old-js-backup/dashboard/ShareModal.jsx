import React, { useState } from 'react';
import { X, Copy, Check, Lock, Clock, Download } from 'lucide-react';

export default function ShareModal({ shareData, onClose, darkMode }) {
  const [copied, setCopied] = useState(false);

  const shareUrl = shareData?.share_url ?? '';

  const handleCopy = () => {
    if (!shareUrl) return;
    navigator.clipboard.writeText(shareUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const infoItems = [
    {
      Icon: Clock,
      label: 'Expires',
      value: shareData?.expires_at
        ? new Date(shareData.expires_at).toLocaleString()
        : 'No expiry',
    },
    {
      Icon: Lock,
      label: 'Password',
      value: shareData?.password_protected ? 'Enabled' : 'None',
    },
    {
      Icon: Download,
      label: 'Downloads',
      value:
        typeof shareData?.max_downloads === 'number'
          ? `${shareData?.downloads_used ?? 0}/${shareData.max_downloads}`
          : 'Unlimited',
    },
  ];

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div
        className={`p-6 rounded-lg max-w-md w-full ${
          darkMode ? 'bg-gray-800' : 'bg-white'
        }`}
      >
        <div className="flex justify-between items-center mb-4">
          <h3
            className={`text-lg font-semibold ${
              darkMode ? 'text-white' : 'text-gray-900'
            }`}
          >
            Share Link Created
          </h3>
          <button
            onClick={onClose}
            className={`p-1 rounded ${
              darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'
            }`}
          >
            <X size={20} />
          </button>
        </div>

        {/* Share URL field */}
        <div
          className={`p-3 rounded mb-4 ${
            darkMode ? 'bg-gray-700' : 'bg-gray-100'
          }`}
        >
          <p className="text-sm text-gray-500 mb-1">Share URL:</p>
          <div className="flex items-center gap-2">
            <p
              className={`text-sm break-all flex-1 ${
                darkMode ? 'text-white' : 'text-gray-900'
              }`}
            >
              {shareUrl}
            </p>
            <button
              onClick={handleCopy}
              className={`p-2 rounded ${
                darkMode ? 'hover:bg-gray-600' : 'hover:bg-gray-200'
              }`}
              title="Copy link"
            >
              {copied ? (
                <Check size={16} className="text-green-500" />
              ) : (
                <Copy size={16} />
              )}
            </button>
          </div>
        </div>

        {/* Share options info */}
        <div className="space-y-2">
          {infoItems.map(({ Icon, label, value }) => (
            <div key={label} className="flex justify-between items-center py-2">
              <span className="flex items-center gap-2">
                <Icon
                  size={16}
                  className={darkMode ? 'text-gray-300' : 'text-gray-600'}
                />
                <span
                  className={`text-sm ${
                    darkMode ? 'text-gray-300' : 'text-gray-600'
                  }`}
                >
                  {label}
                </span>
              </span>
              <kbd
                className={`px-2 py-1 rounded text-sm font-mono ${
                  darkMode
                    ? 'bg-gray-700 text-gray-300'
                    : 'bg-gray-200 text-gray-700'
                }`}
              >
                {value}
              </kbd>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}