import React, { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { IconButton } from './IconButton';
import { useBodyScrollLock, useEscapeKey, useFocusTrap, useRestoreFocus } from './_hooks';

/**
 * Drawer — slide-in sheet from left or right. Same accessibility contract as
 * Modal (focus trap, ESC, backdrop dismiss, body scroll lock). Prefer Drawer
 * over Modal for long-form side content (share options, filter panels).
 */

type DrawerSide = 'left' | 'right';
type DrawerSize = 'sm' | 'md' | 'lg';

const widthClass: Record<DrawerSize, string> = {
  sm: 'w-80',
  md: 'w-96',
  lg: 'w-[32rem]',
};

const sideClass: Record<DrawerSide, string> = {
  left: 'left-0 border-r',
  right: 'right-0 border-l',
};

// Slide-in keyframe on mount. We use inline style rather than bloating tailwind.
const slideStyle = (side: DrawerSide): React.CSSProperties => ({
  animation: `drawer-slide-${side} var(--duration-base, 240ms) var(--ease-out-expo, cubic-bezier(0.19, 1, 0.22, 1)) both`,
});

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  side?: DrawerSide;
  size?: DrawerSize;
  title?: React.ReactNode;
  description?: React.ReactNode;
  dismissOnBackdropClick?: boolean;
  dismissOnEscape?: boolean;
  hideCloseButton?: boolean;
  className?: string;
  children: React.ReactNode;
}

export const Drawer: React.FC<DrawerProps> = ({
  open,
  onClose,
  side = 'right',
  size = 'md',
  title,
  description,
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
    <div className="fixed inset-0 z-[100]" role="presentation">
      {/* Inline keyframes so we don't require a tailwind plugin. */}
      <style>{`
        @keyframes drawer-slide-right { from { transform: translateX(100%); } to { transform: translateX(0); } }
        @keyframes drawer-slide-left  { from { transform: translateX(-100%); } to { transform: translateX(0); } }
      `}</style>
      <div
        aria-hidden
        onClick={dismissOnBackdropClick ? onClose : undefined}
        className="absolute inset-0 bg-bg/70 backdrop-blur-sm"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? headingId : undefined}
        aria-describedby={description ? descId : undefined}
        style={slideStyle(side)}
        className={cn(
          'absolute top-0 bottom-0 bg-surface text-fg shadow-2xl border-border',
          'flex flex-col',
          widthClass[size],
          sideClass[side],
          className
        )}
      >
        {(title || description || !hideCloseButton) && (
          <div className="flex items-start justify-between gap-4 border-b border-border px-6 py-4 shrink-0">
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
              <IconButton variant="ghost" size="sm" onClick={onClose} aria-label="Close drawer">
                <X />
              </IconButton>
            )}
          </div>
        )}
        <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
      </div>
    </div>,
    document.body
  );
};
