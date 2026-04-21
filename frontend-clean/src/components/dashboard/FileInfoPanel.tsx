import React, { useState, useEffect, useCallback } from 'react';
import { Info, Clock, Shield, FileText, Eye, Copy, Layers } from 'lucide-react';
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
import { Badge, Banner, Button, Drawer, EmptyState, Spinner } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * FileInfoPanel — right-hand drawer showing multi-tab file metadata:
 * Details / Activity / Security plus (for non-ZK files) AI-derived
 * Summary / OCR / Similar files. All AI endpoints are lazy-fetched per tab.
 */
const FileInfoPanel: React.FC<FileInfoPanelProps> = ({
  file,
  onClose,
  onRename,
  darkMode,
  isZK = false,
}) => {
  const [activeTab, setActiveTab] = useState<string>('details');

  const [summary, setSummary] = useState<FileSummary | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryIneligible, setSummaryIneligible] = useState(false);

  const [ocrData, setOcrData] = useState<{
    extracted_text: string;
    word_count: number;
    confidence: number;
  } | null>(null);
  const [ocrLoading, setOcrLoading] = useState(false);
  const [ocrError, setOcrError] = useState<string | null>(null);

  const [similarFiles, setSimilarFiles] = useState<
    {
      file_id: string;
      file_name: string;
      file_size: number;
      mime_type: string;
      similarity_score: number;
      common_keywords?: string[];
    }[]
  >([]);
  const [similarLoading, setSimilarLoading] = useState(false);
  const [similarError, setSimilarError] = useState<string | null>(null);

  useEffect(() => {
    setSummary(null);
    setSummaryError(null);
    setSummaryIneligible(false);
    setOcrData(null);
    setOcrError(null);
    setSimilarFiles([]);
    setSimilarError(null);
  }, [file?.id]);

  useEffect(() => {
    if (activeTab !== 'summary' || !file || isZK) return;
    let cancelled = false;
    (async () => {
      try {
        const data = await getFileSummary(file.id);
        if (!cancelled) setSummary(data);
      } catch {
        // No cached summary — user can generate
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab, file?.id, isZK]);

  const handleGenerateSummary = useCallback(
    async (regenerate = false) => {
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
    },
    [file?.id]
  );

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
        if (!res.ok)
          throw new Error(
            res.status === 404
              ? 'No OCR data available. Run analysis first.'
              : `Error: ${res.status}`
          );
        const data = await res.json();
        if (!cancelled) setOcrData(data);
      } catch (err: any) {
        if (!cancelled) setOcrError(err?.message || 'Failed to load OCR text');
      } finally {
        if (!cancelled) setOcrLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeTab, file?.id, isZK]);

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
    return () => {
      cancelled = true;
    };
  }, [activeTab, file?.id, isZK]);

  const baseTabs: FileInfoTab[] = [
    { id: 'details', label: 'Details', icon: Info },
    { id: 'activity', label: 'Activity', icon: Clock },
    { id: 'security', label: 'Security', icon: Shield },
  ];

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
    <Drawer open onClose={onClose} side="right" size="md" title="File information">
      <div className="flex h-full flex-col">
        {/* Tabs */}
        <div className="flex border-b border-border">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'relative flex flex-1 items-center justify-center gap-2 px-4 py-3 text-body-sm font-medium transition-colors',
                  isActive ? 'text-primary' : 'text-fg-muted hover:text-fg'
                )}
              >
                <Icon size={16} />
                <span>{tab.label}</span>
                {isActive && (
                  <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
                )}
              </button>
            );
          })}
        </div>

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeTab === 'details' && (
            <FileDetailsTab file={file} onRename={onRename} darkMode={darkMode} isZK={isZK} />
          )}
          {activeTab === 'activity' && <FileActivityTab file={file} darkMode={darkMode} />}
          {activeTab === 'security' && <FileSecurityTab file={file} darkMode={darkMode} />}

          {activeTab === 'summary' && !isZK && (
            <div className="space-y-4">
              {summaryLoading && (
                <div className="flex items-center gap-2 text-body-sm text-fg-muted">
                  <Spinner size="sm" />
                  Generating summary...
                </div>
              )}

              {summaryIneligible && (
                <Banner variant="warning">
                  {summaryError || 'Summary unavailable for this file type'}
                </Banner>
              )}

              {!summaryLoading && !summaryIneligible && summaryError && (
                <Banner variant="danger">{summaryError}</Banner>
              )}

              {summary ? (
                <>
                  <div className="rounded-lg bg-surface-muted p-4 text-body-sm leading-relaxed text-fg">
                    {summary.summary}
                  </div>
                  <div className="flex items-center gap-3 text-caption text-fg-subtle">
                    <span>{summary.word_count} words</span>
                    <Badge variant="neutral" size="sm">
                      {summary.model_used}
                    </Badge>
                  </div>
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => handleGenerateSummary(true)}
                    disabled={summaryLoading}
                  >
                    Regenerate
                  </Button>
                </>
              ) : (
                !summaryLoading &&
                !summaryIneligible && (
                  <Button
                    variant="primary"
                    className="w-full"
                    onClick={() => handleGenerateSummary(false)}
                  >
                    Generate summary
                  </Button>
                )
              )}
            </div>
          )}

          {activeTab === 'ocr' && !isZK && (
            <div className="space-y-4">
              {ocrLoading && (
                <div className="flex items-center gap-2 text-body-sm text-fg-muted">
                  <Spinner size="sm" />
                  Loading extracted text...
                </div>
              )}

              {ocrError && <Banner variant="warning">{ocrError}</Banner>}

              {ocrData && (
                <>
                  <div className="mb-2 flex items-center gap-3 text-caption text-fg-subtle">
                    <span>{ocrData.word_count} words</span>
                    <Badge variant="neutral" size="sm">
                      {ocrData.confidence}% confidence
                    </Badge>
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => navigator.clipboard.writeText(ocrData.extracted_text)}
                      leftIcon={<Copy className="h-3 w-3" />}
                      title="Copy text"
                    >
                      Copy
                    </Button>
                  </div>
                  <pre className="max-h-[400px] overflow-auto whitespace-pre-wrap rounded-lg bg-surface-muted p-4 text-caption leading-relaxed text-fg">
                    {ocrData.extracted_text}
                  </pre>
                </>
              )}
            </div>
          )}

          {activeTab === 'similar' && !isZK && (
            <div className="space-y-4">
              {similarLoading && (
                <div className="flex items-center gap-2 text-body-sm text-fg-muted">
                  <Spinner size="sm" />
                  Finding similar files...
                </div>
              )}

              {similarError && <Banner variant="warning">{similarError}</Banner>}

              {!similarLoading && !similarError && similarFiles.length === 0 && (
                <EmptyState
                  icon={<Layers />}
                  title="No similar files found"
                  description="We couldn't find files with overlapping content."
                  size="sm"
                />
              )}

              {similarFiles.length > 0 && (
                <div className="space-y-2">
                  {similarFiles.map((sf) => {
                    const scoreTone =
                      sf.similarity_score >= 0.8
                        ? ('success' as const)
                        : sf.similarity_score >= 0.5
                          ? ('info' as const)
                          : ('neutral' as const);
                    return (
                      <div
                        key={sf.file_id}
                        className="rounded-lg border border-border bg-surface p-3"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-body-sm font-medium text-fg">
                              {sf.file_name}
                            </p>
                            <div className="mt-0.5 flex items-center gap-2 text-caption text-fg-muted">
                              <span>{formatBytes(sf.file_size)}</span>
                              {sf.mime_type && <span>{sf.mime_type.split('/').pop()}</span>}
                            </div>
                          </div>
                          <Badge variant={scoreTone} size="sm">
                            {(sf.similarity_score * 100).toFixed(0)}%
                          </Badge>
                        </div>
                        {sf.common_keywords && sf.common_keywords.length > 0 && (
                          <div className="mt-2 flex flex-wrap gap-1">
                            {sf.common_keywords.slice(0, 4).map((kw) => (
                              <Badge key={kw} variant="neutral" size="sm">
                                {kw}
                              </Badge>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Drawer>
  );
};

export default FileInfoPanel;
