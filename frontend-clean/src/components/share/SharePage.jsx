import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Download, Lock, AlertCircle, CheckCircle, Cloud, FileText, Loader } from 'lucide-react';
import { API_URL } from '../../config/constants';
import { formatBytes } from '../../utils/helpers';

export default function SharePage() {
  const { token } = useParams();
  const navigate = useNavigate();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [requiresPassword, setRequiresPassword] = useState(false);
  const [password, setPassword] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [fileInfo, setFileInfo] = useState(null);

  useEffect(() => {
    // Page is ready - just show download UI
    setLoading(false);
  }, [token]);

  const handleDownload = async () => {
    setDownloading(true);
    setError('');

    try {
      const url = new URL(`${API_URL}/share/${token}`);
      if (password) {
        url.searchParams.append('password', password);
      }

      const response = await fetch(url.toString());

      if (response.status === 401) {
        setError('Password required or invalid');
        setRequiresPassword(true);
        setDownloading(false);
        return;
      } else if (response.status === 404) {
        setError('Share link not found or has expired');
        setDownloading(false);
        return;
      } else if (response.status === 410) {
        setError('Share link has expired');
        setDownloading(false);
        return;
      } else if (response.status === 403) {
        setError('Download limit exceeded for this share link');
        setDownloading(false);
        return;
      } else if (!response.ok) {
        setError('Failed to download file');
        setDownloading(false);
        return;
      }

      // Extract filename from Content-Disposition header
      const contentDisposition = response.headers.get('Content-Disposition');
      let filename = 'download';
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="?(.+)"?/i);
        if (filenameMatch) {
          filename = filenameMatch[1];
        }
      }

      // Download the file
      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = downloadUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(downloadUrl);

      setDownloading(false);
    } catch (err) {
      console.error('Download failed:', err);
      setError('Download failed');
      setDownloading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-50 via-purple-50 to-pink-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl max-w-md w-full p-8">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <div className="p-3 rounded-xl bg-gradient-to-br from-blue-500 to-purple-600">
            <Cloud className="text-white" size={24} />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Edge Cloud Storage</h1>
            <p className="text-sm text-gray-500">Shared File</p>
          </div>
        </div>

        {loading ? (
          <div className="flex flex-col items-center justify-center py-12">
            <Loader className="animate-spin text-blue-500 mb-3" size={32} />
            <p className="text-gray-600">Checking share link...</p>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-12">
            <AlertCircle className="text-red-500 mb-3" size={48} />
            <p className="text-red-600 text-center mb-4">{error}</p>
            <button
              onClick={() => navigate('/auth')}
              className="px-4 py-2 rounded-lg bg-blue-500 text-white hover:bg-blue-600 transition-colors"
            >
              Go to Login
            </button>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Info Box */}
            <div className="bg-gray-50 rounded-lg p-4">
              <div className="flex items-center gap-3 mb-2">
                <FileText className="text-gray-600" size={20} />
                <span className="font-medium text-gray-900">Shared File</span>
              </div>
              <p className="text-sm text-gray-500 ml-8">
                Click download to access this file
              </p>
            </div>

            {/* Password Input - Show if required or on error */}
            {requiresPassword && (
              <div>
                <label className="flex items-center gap-2 mb-2 text-sm font-medium text-gray-700">
                  <Lock size={16} />
                  Password Required
                </label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyPress={(e) => e.key === 'Enter' && !downloading && password && handleDownload()}
                  className="w-full px-4 py-2 rounded-lg border border-gray-300 focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Enter password"
                  disabled={downloading}
                  autoFocus
                />
              </div>
            )}

            {/* Optional Password Field - Show button if not yet required */}
            {!requiresPassword && (
              <div>
                <button
                  onClick={() => setRequiresPassword(true)}
                  className="text-sm text-blue-500 hover:text-blue-600 flex items-center gap-1"
                >
                  <Lock size={14} />
                  This file is password protected? Click here
                </button>
              </div>
            )}

            {/* Download Button */}
            <button
              onClick={handleDownload}
              disabled={downloading || (requiresPassword && !password)}
              className={`w-full py-3 rounded-lg flex items-center justify-center gap-2 transition-all shadow-lg ${
                downloading || (requiresPassword && !password)
                  ? 'bg-gray-300 cursor-not-allowed'
                  : 'bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white'
              }`}
            >
              {downloading ? (
                <>
                  <Loader className="animate-spin" size={20} />
                  Downloading...
                </>
              ) : (
                <>
                  <Download size={20} />
                  Download File
                </>
              )}
            </button>

            {/* Footer */}
            <div className="text-center pt-4 border-t">
              <p className="text-sm text-gray-500">
                Powered by Edge Cloud Storage
              </p>
              <button
                onClick={() => navigate('/auth')}
                className="text-sm text-blue-500 hover:text-blue-600 mt-2"
              >
                Sign in to your account
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
