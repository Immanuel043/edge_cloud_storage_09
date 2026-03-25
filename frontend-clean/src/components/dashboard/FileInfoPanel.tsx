import React, { useState, useEffect, useCallback } from 'react';
import { X, Info, Clock, Shield, FileText, Eye, Copy, Layers } from 'lucide-react';
import FileDetailsTab from './FileDetailsTab';
import FileActivityTab from './FileActivityTab';
import FileSecurityTab from './FileSecurityTab';
import type { FileInfoPanelProps, FileInfoTab } from './types';
import {
  getFileSummary,
  generateFileSummary,
  regenerateFileSummary,
  type FileSummary,
} from '../../services/summaryService';
import { recommendationService } from '../../services/recommendationService';
import { formatBytes } from '../../utils/helpers';

/**
 * FileInfoPanel Component
 *
 * Side panel showing file details, activity, and security information.
 */
const FileInfoPanel: React.FC<FileInfoPanelProps> = ({
  file,
  onClose,
  onRename,
  darkMode,
  isZK = false,
}) => {
  const [activeTab, setActiveTab] = useState<string>('details');

  // Summary state
  const [summary, setSummary] = useState<FileSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryIneligible, setSummaryIneligible] = useState(false);

  // OCR state
  const [ocrData, setOcrData] = useState<{
    extracted_text: string;
    word_count: number;
    confidence: number;
  } | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);

  // Similar files state
  const [similarFiles, setSimilarFiles] = useState<
    { file_id: string; file_name: string; file_size: number; mime_type: string; similarity_score: number; common_keywords?: string[] }[]
  >([]);
  const [similarLoading, setSimilarLoading] = useState(false);
  const [similarError, setSimilarError] = useState<string | null>(null);

  // Reset state when file changes
  useEffect(() => {
    setSummary(null);
    setSummaryError(null);
    setSummaryIneligible(false);
    setOcrData(null);
    setOcrError(null);
    setSimilarFiles([]);
    setSimilarError(null);
  }, [file?.id]);

  // Fetch cached summary when tab is activated
  useEffect(() => {
    if (activeTab !== 'summary' || !file || isZK) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await getFileSummary(file.id);
        if (!cancelled) setSummary(data);
      } catch {
        // No cached summary — that's fine, user can generate
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, file?.id, isZK]);

  const handleGenerateSummary = useCallback(async (regenerate = false) => {
    if (!file) return;
    setSummaryLoading(true);
    setSummaryError(null);
    setSummaryIneligible(false);
    try {
      const data = regenerate
        ? await regenerateFileSummary(file.id)
        : await generateFileSummary(file.id);
      setSummary(data);
    } catch (err: any) {
      const msg = err?.message || 'Failed to generate summary';
      if (msg.startsWith('INELIGIBLE:')) {
        setSummaryIneligible(true);
        setSummaryError(msg.replace('INELIGIBLE: ', ''));
      } else {
        setSummaryError(msg);
      }
    } finally {
      setSummaryLoading(false);
    }
  }, [file?.id]);

  // Fetch OCR text when tab is activated
  useEffect(() => {
    if (activeTab !== 'ocr' || !file || isZK) return;
    let cancelled = false;
    (async () => {
      setOcrLoading(true);
      setOcrError(null);
      try {
        const { API_URL } = await import('../../config/constants');
        const res = await fetch(`${API_URL}/api/v1/files/${file.id}/ocr`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error(res.status === 404 ? 'No OCR data available. Run analysis first.' : `Error: ${res.status}`);
        const data = await res.json();
        if (!cancelled) setOcrData(data);
      } catch (err: any) {
        if (!cancelled) setOcrError(err?.message || 'Failed to load OCR text');
      } finally {
        if (!cancelled) setOcrLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, file?.id, isZK]);

  // Fetch similar files when tab is activated
  useEffect(() => {
    if (activeTab !== 'similar' || !file || isZK) return;
    let cancelled = false;
    (async () => {
      setSimilarLoading(true);
      setSimilarError(null);
      try {
        const data = await recommendationService.getSimilarFiles(file.id, 6, 0.2);
        if (!cancelled) setSimilarFiles(data);
      } catch (err: any) {
        if (!cancelled) setSimilarError(err?.message || 'Failed to load similar files');
      } finally {
        if (!cancelled) setSimilarLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [activeTab, file?.id, isZK]);

  const baseTabs: FileInfoTab[] = [
    { id: 'details', label: 'Details', icon: Info },
    { id: 'activity', label: 'Activity', icon: Clock },
    { id: 'security', label: 'Security', icon: Shield },
  ];

  // AI tabs only for non-ZK files
  const aiTabs: FileInfoTab[] = isZK
    ? []
    : [
        { id: 'summary', label: 'Summary', icon: FileText },
        { id: 'ocr', label: 'OCR Text', icon: Eye },
        { id: 'similar', label: 'Similar', icon: Layers },
      ];

  const tabs: FileInfoTab[] = [...baseTabs, ...aiTabs];

  if (!file) return null;

  return (
    <>
      {/* Overlay */}
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />

      {/* Side Panel */}
      <div
        className={`fixed right-0 top-0 bottom-0 w-full md:w-[400px] z-50 shadow-2xl transform transition-transform duration-300 flex flex-col ${
          darkMode ? 'bg-gray-800' : 'bg-white'
        }`}
      >
        {/* Header */}
        <div
          className={`flex items-center justify-between px-6 py-4 border-b ${
            darkMode ? 'border-gray-700' : 'border-gray-200'
          }`}
        >
          <h2 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            File Information
          </h2>
          <button
            onClick={onClose}
            className={`p-2 rounded-lg transition-colors ${
              darkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-500'
            }`}
          >
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className={`flex border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex-1 flex items-center justify-center gap-2 px-4 py-3 text-sm font-medium transition-colors relative ${
                  activeTab === tab.id
                    ? darkMode
                      ? 'text-blue-400'
                      : 'text-blue-600'
                    : darkMode
                      ? 'text-gray-400 hover:text-gray-300'
                      : 'text-gray-600 hover:text-gray-900'
                }`}
              >
                <Icon size={16} />
                <span>{tab.label}</span>
                {activeTab === tab.id && (
                  <div
                    className={`absolute bottom-0 left-0 right-0 h-0.5 ${
                      darkMode ? 'bg-blue-400' : 'bg-blue-600'
                    }`}
                  />
                )}
              </button>
            );
          })}
        </div>

        {/* Tab Content */}
        <div className="overflow-y-auto flex-1 p-6">
          {activeTab === 'details' && (
            <FileDetailsTab file={file} onRename={onRename} darkMode={darkMode} isZK={isZK} />
          )}
          {activeTab === 'activity' && <FileActivityTab file={file} darkMode={darkMode} />}
          {activeTab === 'security' && <FileSecurityTab file={file} darkMode={darkMode} />}

          {/* Summary Tab */}
          {activeTab === 'summary' && !isZK && (
            <div className="space-y-4">
              {summaryLoading && (
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  Generating summary...
                </div>
              )}

              {summaryIneligible && (
                <div className={`p-3 rounded-lg text-sm ${darkMode ? 'bg-yellow-900/20 text-yellow-400' : 'bg-yellow-50 text-yellow-700'}`}>
                  {summaryError || 'Summary unavailable for this file type'}
                </div>
              )}

              {!summaryLoading && !summaryIneligible && summaryError && (
                <div className={`p-3 rounded-lg text-sm ${darkMode ? 'bg-red-900/20 text-red-400' : 'bg-red-50 text-red-700'}`}>
                  {summaryError}
                </div>
              )}

              {summary ? (
                <>
                  <div className={`p-4 rounded-lg text-sm leading-relaxed ${darkMode ? 'bg-gray-700/50 text-gray-200' : 'bg-gray-50 text-gray-700'}`}>
                    {summary.summary}
                  </div>
                  <div className="flex items-center gap-3 text-xs text-gray-500">
                    <span>{summary.word_count} words</span>
                    <span className={`px-2 py-0.5 rounded-full ${darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-600'}`}>
                      {summary.model_used}
                    </span>
                  </div>
                  <button
                    onClick={() => handleGenerateSummary(true)}
                    disabled={summaryLoading}
                    className={`text-sm font-medium ${darkMode ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-700'}`}
                  >
                    Regenerate
                  </button>
                </>
              ) : (
                !summaryLoading && !summaryIneligible && (
                  <button
                    onClick={() => handleGenerateSummary(false)}
                    className="w-full px-4 py-3 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 transition-colors"
                  >
                    Generate Summary
                  </button>
                )
              )}
            </div>
          )}

          {/* OCR Text Tab */}
          {activeTab === 'ocr' && !isZK && (
            <div className="space-y-4">
              {ocrLoading && (
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  Loading extracted text...
                </div>
              )}

              {ocrError && (
                <div className={`p-3 rounded-lg text-sm ${darkMode ? 'bg-yellow-900/20 text-yellow-400' : 'bg-yellow-50 text-yellow-700'}`}>
                  {ocrError}
                </div>
              )}

              {ocrData && (
                <>
                  <div className="flex items-center gap-3 text-xs text-gray-500 mb-2">
                    <span>{ocrData.word_count} words</span>
                    <span className={`px-2 py-0.5 rounded-full ${darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-600'}`}>
                      {ocrData.confidence}% confidence
                    </span>
                    <button
                      onClick={() => navigator.clipboard.writeText(ocrData.extracted_text)}
                      className={`flex items-center gap-1 ${darkMode ? 'text-gray-400 hover:text-gray-300' : 'text-gray-500 hover:text-gray-700'}`}
                      title="Copy text"
                    >
                      <Copy size={12} /> Copy
                    </button>
                  </div>
                  <pre className={`p-4 rounded-lg text-xs leading-relaxed overflow-auto max-h-[400px] whitespace-pre-wrap ${
                    darkMode ? 'bg-gray-700/50 text-gray-200' : 'bg-gray-50 text-gray-700'
                  }`}>
                    {ocrData.extracted_text}
                  </pre>
                </>
              )}
            </div>
          )}

          {/* Similar Files Tab */}
          {activeTab === 'similar' && !isZK && (
            <div className="space-y-4">
              {similarLoading && (
                <div className="flex items-center gap-2 text-sm text-gray-500">
                  <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
                  Finding similar files...
                </div>
              )}

              {similarError && (
                <div className={`p-3 rounded-lg text-sm ${darkMode ? 'bg-yellow-900/20 text-yellow-400' : 'bg-yellow-50 text-yellow-700'}`}>
                  {similarError}
                </div>
              )}

              {!similarLoading && !similarError && similarFiles.length === 0 && (
                <div className={`text-center py-6 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                  <Layers size={32} className="mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No similar files found.</p>
                </div>
              )}

              {similarFiles.length > 0 && (
                <div className="space-y-2">
                  {similarFiles.map((sf) => (
                    <div
                      key={sf.file_id}
                      className={`p-3 rounded-lg border ${darkMode ? 'border-gray-700 bg-gray-700/30' : 'border-gray-200 bg-gray-50'}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex-1 min-w-0">
                          <p className={`text-sm font-medium truncate ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                            {sf.file_name}
                          </p>
                          <div className={`flex items-center gap-2 mt-0.5 text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
                            <span>{formatBytes(sf.file_size)}</span>
                            {sf.mime_type && <span>{sf.mime_type.split('/').pop()}</span>}
                          </div>
                        </div>
                        <div className={`px-2 py-1 rounded text-xs font-medium ${
                          sf.similarity_score >= 0.8
                            ? darkMode ? 'bg-green-900/30 text-green-400' : 'bg-green-100 text-green-700'
                            : sf.similarity_score >= 0.5
                              ? darkMode ? 'bg-blue-900/30 text-blue-400' : 'bg-blue-100 text-blue-700'
                              : darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-600'
                        }`}>
                          {(sf.similarity_score * 100).toFixed(0)}%
                        </div>
                      </div>
                      {sf.common_keywords && sf.common_keywords.length > 0 && (
                        <div className="flex flex-wrap gap-1 mt-2">
                          {sf.common_keywords.slice(0, 4).map(kw => (
                            <span
                              key={kw}
                              className={`text-[10px] px-1.5 py-0.5 rounded ${darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-600'}`}
                            >
                              {kw}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
};

export default FileInfoPanel;
