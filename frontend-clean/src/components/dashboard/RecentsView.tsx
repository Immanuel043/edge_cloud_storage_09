import React, { useMemo } from 'react';
import { Clock, AlertCircle } from 'lucide-react';
import FileGrid from './FileGrid';
import FileList from './FileList';
import { useRecents } from '../../hooks/useRecents';
import type { RecentsViewProps, FileItem } from './types';
import {
  Badge,
  Banner,
  Button,
  Card,
  CardContent,
  EmptyState,
  Spinner,
} from '@/components/ui';

/**
 * RecentsView — files the user touched recently, grouped into Today /
 * Yesterday / This week / This month / Older. Each group delegates to
 * FileGrid or FileList per current viewMode. Built on Signal primitives:
 * Card shell, EmptyState for zero-recents, Banner for fetch errors, Spinner
 * for loading.
 */

interface GroupedFiles {
  today: FileItem[];
  yesterday: FileItem[];
  thisWeek: FileItem[];
  thisMonth: FileItem[];
  older: FileItem[];
}

interface TimeGroupProps {
  title: string;
  files: FileItem[];
  viewMode: 'grid' | 'list';
  selectedFiles: Set<string>;
  onFileClick: RecentsViewProps['onFileClick'];
  onFilePreview: RecentsViewProps['onFilePreview'];
  onFileDownload: RecentsViewProps['onFileDownload'];
  onFileShare: RecentsViewProps['onFileShare'];
  onFileDelete: RecentsViewProps['onFileDelete'];
  onVersionHistory: RecentsViewProps['onVersionHistory'];
  darkMode: boolean;
}

const TimeGroup: React.FC<TimeGroupProps> = ({
  title,
  files,
  viewMode,
  selectedFiles,
  onFileClick,
  onFilePreview,
  onFileDownload,
  onFileShare,
  onFileDelete,
  onVersionHistory,
  darkMode,
}) => {
  if (files.length === 0) return null;

  return (
    <div className="mb-8">
      <h2 className="mb-4 text-caption font-semibold uppercase tracking-wide text-fg-muted">
        {title}
      </h2>
      {viewMode === 'grid' ? (
        <FileGrid
          folders={[]}
          files={files}
          selectedFiles={selectedFiles}
          onFolderClick={() => {}}
          onFileClick={onFileClick}
          onFilePreview={onFilePreview}
          onFileDownload={onFileDownload}
          onFileShare={onFileShare}
          onFileDelete={onFileDelete}
          onVersionHistory={onVersionHistory}
          darkMode={darkMode}
        />
      ) : (
        <FileList
          folders={[]}
          files={files}
          selectedFiles={selectedFiles}
          onFolderClick={() => {}}
          onFileClick={onFileClick}
          onFilePreview={onFilePreview}
          onFileDownload={onFileDownload}
          onFileShare={onFileShare}
          onFileDelete={onFileDelete}
          onVersionHistory={onVersionHistory}
          darkMode={darkMode}
        />
      )}
    </div>
  );
};

const RecentsView: React.FC<RecentsViewProps> = ({
  viewMode,
  darkMode,
  selectedFiles,
  onFileClick,
  onFilePreview,
  onFileDownload,
  onFileShare,
  onFileDelete,
  onVersionHistory,
}) => {
  const { recents, loading, error, refresh } = useRecents(true);

  const groupedFiles = useMemo<GroupedFiles>(() => {
    const now = new Date();
    const groups: GroupedFiles = {
      today: [],
      yesterday: [],
      thisWeek: [],
      thisMonth: [],
      older: [],
    };

    recents.forEach((file: FileItem) => {
      const fileDate = new Date(file.last_accessed ?? file.created_at ?? '');
      const daysDiff = Math.floor((now.getTime() - fileDate.getTime()) / (1000 * 60 * 60 * 24));

      if (daysDiff === 0) groups.today.push(file);
      else if (daysDiff === 1) groups.yesterday.push(file);
      else if (daysDiff <= 7) groups.thisWeek.push(file);
      else if (daysDiff <= 30) groups.thisMonth.push(file);
      else groups.older.push(file);
    });

    return groups;
  }, [recents]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Spinner size="lg" />
      </div>
    );
  }

  if (error) {
    return (
      <Banner
        variant="danger"
        icon={<AlertCircle />}
        title="Failed to load recent files"
        action={
          <Button variant="primary" size="sm" onClick={refresh}>
            Try again
          </Button>
        }
      >
        {error}
      </Banner>
    );
  }

  if (recents.length === 0) {
    return (
      <Card variant="bordered">
        <CardContent className="p-6">
          <EmptyState
            icon={<Clock />}
            title="No recent files"
            description="Files you access will appear here for easy access."
            size="lg"
          />
        </CardContent>
      </Card>
    );
  }

  const commonProps = {
    viewMode,
    selectedFiles,
    onFileClick,
    onFilePreview,
    onFileDownload,
    onFileShare,
    onFileDelete,
    onVersionHistory,
    darkMode,
  };

  return (
    <Card variant="bordered">
      <CardContent className="p-6">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Clock className="h-6 w-6 text-primary" />
            <h1 className="text-h2 font-bold text-fg">Recent files</h1>
          </div>
          <Badge variant="neutral" size="sm">
            {recents.length} recent files
          </Badge>
        </div>

        <div className="space-y-8">
          <TimeGroup title="Today" files={groupedFiles.today} {...commonProps} />
          <TimeGroup title="Yesterday" files={groupedFiles.yesterday} {...commonProps} />
          <TimeGroup title="This week" files={groupedFiles.thisWeek} {...commonProps} />
          <TimeGroup title="This month" files={groupedFiles.thisMonth} {...commonProps} />
          <TimeGroup title="Older" files={groupedFiles.older} {...commonProps} />
        </div>
      </CardContent>
    </Card>
  );
};

export default RecentsView;
