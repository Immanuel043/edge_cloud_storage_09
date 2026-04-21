import React, { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { IconButton } from './IconButton';
import { useBodyScrollLock, useEscapeKey, useFocusTrap, useRestoreFocus } from './_hooks';

/**
 * Modal — centered dialog with focus trap, ESC close, backdrop click, and
 * animated enter. Use with ModalHeader / ModalBody / ModalFooter for layout.
 *
 *   <Modal open={open} onClose={() => setOpen(false)} size="md" title="Share file">
 *     <ModalBody>...</ModalBody>
 *     <ModalFooter>...</ModalFooter>
 *   </Modal>
 */

type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | 'fullscreen';

const sizeClass: Record<ModalSize, string> = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-2xl',
  xl: 'max-w-4xl',
  fullscreen: 'max-w-none w-[calc(100vw-2rem)] h-[calc(100vh-2rem)]',
};

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Convenience: render a styled header with this title + close button. */
  title?: React.ReactNode;
  /** Convenience: description rendered under the title. */
  description?: React.ReactNode;
  size?: ModalSize;
  /** Close when the backdrop is clicked. Default: true. */
  dismissOnBackdropClick?: boolean;
  /** Close on ESC. Default: true. */
  dismissOnEscape?: boolean;
  /** Hide the default close X in the top-right of the header. */
  hideCloseButton?: boolean;
  className?: string;
  children: React.ReactNode;
}

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  description,
  size = 'md',
  dismissOnBackdropClick = true,
  dismissOnEscape = true,
  hideCloseButton,
  className,
  children,
}) => {
  const panelRef = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const descId = useId();

  useBodyScrollLock(open);
  useRestoreFocus(open);
  useFocusTrap(panelRef as React.RefObject<HTMLElement>, open);
  useEscapeKey(() => dismissOnEscape && onClose(), open);

  if (!open) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="presentation"
    >
      {/* Backdrop */}
      <div
        aria-hidden
        onClick={dismissOnBackdropClick ? onClose : undefined}
        className="absolute inset-0 bg-bg/70 backdrop-blur-sm"
      />
      {/* Panel */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? headingId : undefined}
        aria-describedby={description ? descId : undefined}
        className={cn(
          'relative w-full rounded-2xl bg-surface text-fg shadow-xl border border-border',
          'animate-fade-up',
          'flex flex-col max-h-[calc(100vh-2rem)] overflow-hidden',
          sizeClass[size],
          className
        )}
      >
        {(title || description || !hideCloseButton) && (
          <ModalHeader>
            <div className="flex-1 min-w-0">
              {title && (
                <h2 id={headingId} className="text-h3 text-fg truncate">
                  {title}
                </h2>
              )}
              {description && (
                <p id={descId} className="mt-1 text-body-sm text-fg-muted">
                  {description}
                </p>
              )}
            </div>
            {!hideCloseButton && (
              <IconButton
                variant="ghost"
                size="sm"
                onClick={onClose}
                aria-label="Close dialog"
              >
                <X />
              </IconButton>
            )}
          </ModalHeader>
        )}
        {children}
      </div>
    </div>,
    document.body
  );
};

export const ModalHeader: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => (
  <div
    className={cn(
      'flex items-start justify-between gap-4 border-b border-border px-6 py-4 shrink-0',
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export const ModalBody: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => (
  <div className={cn('flex-1 overflow-y-auto px-6 py-5', className)} {...props}>
    {children}
  </div>
);

export const ModalFooter: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => (
  <div
    className={cn(
      'flex items-center justify-end gap-2 border-t border-border px-6 py-3 shrink-0',
      className
    )}
    {...props}
  >
    {children}
  </div>
);
