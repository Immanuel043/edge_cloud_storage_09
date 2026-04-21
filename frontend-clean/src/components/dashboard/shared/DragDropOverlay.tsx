import React from 'react';
import { UploadCloud } from 'lucide-react';
import { cn } from '@/lib/cn';

/**
 * DragDropOverlay — full-bleed overlay shown while a file drag is active over
 * the dashboard content area. Uses the `pulse-border` animation from the
 * Signal tokens. Consumer is responsible for toggling `active` and forwarding
 * drag events on the containing region.
 */

export interface DragDropOverlayProps {
  active: boolean;
  /** Optional override for the headline copy. */
  title?: string;
  /** Optional override for the supporting copy. */
  description?: string;
  className?: string;
}

export const DragDropOverlay: React.FC<DragDropOverlayProps> = ({
  active,
  title = 'Drop to upload',
  description = 'Release to upload these files to the current folder.',
  className,
}) => {
  if (!active) return null;
  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute inset-0 z-30 flex items-center justify-center',
        'rounded-2xl bg-primary/5 backdrop-blur-[2px]',
        'border-2 border-dashed border-primary animate-pulse-border',
        className
      )}
    >
      <div className="flex flex-col items-center gap-3 text-primary">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-primary/10">
          <UploadCloud className="h-7 w-7" />
        </span>
        <p className="text-h3 font-semibold">{title}</p>
        <p className="max-w-sm text-center text-body-sm text-fg-muted">{description}</p>
      </div>
    </div>
  );
};

export default DragDropOverlay;
