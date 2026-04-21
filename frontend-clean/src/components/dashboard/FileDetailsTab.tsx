import React from 'react';
import {
  FileText,
  Calendar,
  HardDrive,
  MapPin,
  Edit2,
  Image,
  Video,
  Music,
  Archive,
  Code,
} from 'lucide-react';
import { formatBytes, formatDate } from '../../utils/helpers';
import type { FileDetailsTabProps } from './types';
import { Badge, IconButton } from '@/components/ui';

/**
 * FileDetailsTab — core metadata panel for FileInfoPanel. Groups file
 * name/type/format/size/dates/location/tags under consistent section
 * headings; tags are gated "Coming soon" until the backend ships.
 */
const FileDetailsTab: React.FC<FileDetailsTabProps> = ({ file, onRename }) => {
  const getFileIcon = (): React.ReactElement => {
    const mimeType = file.mime_type || file.type || '';
    const name = file.name || '';

    if (mimeType.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(name)) {
      return <Image size={20} className="text-primary" />;
    }
    if (mimeType.startsWith('video/') || /\.(mp4|avi|mov|wmv|webm)$/i.test(name)) {
      return <Video size={20} className="text-accent" />;
    }
    if (mimeType.startsWith('audio/') || /\.(mp3|wav|ogg|flac)$/i.test(name)) {
      return <Music size={20} className="text-accent" />;
    }
    if (
      mimeType.includes('zip') ||
      mimeType.includes('tar') ||
      mimeType.includes('rar') ||
      /\.(zip|tar|gz|rar|7z)$/i.test(name)
    ) {
      return <Archive size={20} className="text-warning" />;
    }
    if (
      mimeType.includes('code') ||
      mimeType.includes('javascript') ||
      mimeType.includes('python') ||
      /\.(js|py|java|cpp|html|css)$/i.test(name)
    ) {
      return <Code size={20} className="text-success" />;
    }
    return <FileText size={20} className="text-fg-subtle" />;
  };

  const getFileFormat = (): string => {
    const name = file.name || '';
    const extension = name.split('.').pop();
    return extension ? extension.toUpperCase() : 'Unknown';
  };

  return (
    <div className="space-y-6">
      <div>
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-body-sm font-semibold text-fg">File name</h3>
          {onRename && (
            <IconButton
              variant="ghost"
              size="sm"
              aria-label="Rename file"
              onClick={() => onRename(file)}
            >
              <Edit2 className="h-3.5 w-3.5" />
            </IconButton>
          )}
        </div>
        <div className="flex items-center gap-3 rounded-lg bg-surface-muted p-3">
          {getFileIcon()}
          <span className="font-medium text-fg">{file.name}</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <SectionKV label="Type" value={file.mime_type || 'Unknown'} />
        <SectionKV label="Format" value={getFileFormat()} />
      </div>

      <SectionWithIcon label="Size" icon={<HardDrive size={16} />}>
        {formatBytes(file.size)}
      </SectionWithIcon>

      <div className="grid grid-cols-2 gap-4">
        <SectionWithIcon label="Created" icon={<Calendar size={16} />}>
          {formatDate(file.created_at)}
        </SectionWithIcon>
        <SectionWithIcon label="Modified" icon={<Calendar size={16} />}>
          {formatDate(file.updated_at || file.created_at)}
        </SectionWithIcon>
      </div>

      {file.pages && (
        <SectionKV
          label="Pages"
          value={`${file.pages} ${file.pages === 1 ? 'page' : 'pages'}`}
        />
      )}

      <SectionWithIcon label="Location" icon={<MapPin size={16} />}>
        {file.folder_path || 'Cloud Drive'}
      </SectionWithIcon>

      <div className="opacity-60">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <p className="text-body-sm font-semibold text-fg">Tags</p>
            <Badge variant="neutral" size="sm">
              Coming soon
            </Badge>
          </div>
        </div>
        <p className="text-body-sm italic text-fg-subtle">
          File tagging will be available in a future update
        </p>
      </div>
    </div>
  );
};

interface SectionKVProps {
  label: string;
  value: string;
}

const SectionKV: React.FC<SectionKVProps> = ({ label, value }) => (
  <div>
    <p className="mb-2 text-body-sm font-semibold text-fg">{label}</p>
    <p className="text-body-sm text-fg-muted">{value}</p>
  </div>
);

interface SectionWithIconProps {
  label: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}

const SectionWithIcon: React.FC<SectionWithIconProps> = ({ label, icon, children }) => (
  <div>
    <p className="mb-2 text-body-sm font-semibold text-fg">{label}</p>
    <div className="flex items-center gap-2 text-body-sm text-fg-muted">
      <span className="text-fg-subtle">{icon}</span>
      <span>{children}</span>
    </div>
  </div>
);

export default FileDetailsTab;
