import React from 'react';
import { Toaster as SonnerToaster, toast as sonnerToast } from 'sonner';
import { useTheme } from '@/contexts/ThemeContext';

/**
 * Toast — brand-wrapped sonner. Mount `<Toaster />` once at the app root, then
 * call `toast.success(...)`, `toast.error(...)`, `toast(...)` from anywhere.
 *
 * Tokens are inlined via CSS variables so both light and dark modes pick up the
 * Signal palette automatically.
 */

export interface ToasterProps {
  position?: React.ComponentProps<typeof SonnerToaster>['position'];
  /** Max visible toasts. Default: 3. */
  visibleToasts?: number;
}

export const Toaster: React.FC<ToasterProps> = ({ position = 'bottom-right', visibleToasts = 3 }) => {
  const { darkMode } = useTheme();
  return (
    <SonnerToaster
      theme={darkMode ? 'dark' : 'light'}
      position={position}
      visibleToasts={visibleToasts}
      closeButton
      richColors={false}
      toastOptions={{
        classNames: {
          toast:
            'group rounded-xl border border-border bg-surface-elevated text-fg shadow-lg font-sans text-body-sm',
          title: 'text-fg font-medium',
          description: 'text-fg-muted',
          actionButton: 'bg-primary text-primary-fg rounded-md px-3 py-1 text-caption font-medium',
          cancelButton: 'bg-surface-muted text-fg-muted rounded-md px-3 py-1 text-caption font-medium',
          closeButton: 'bg-surface-muted border-border text-fg-muted',
          success: 'border-success/40',
          error: 'border-danger/40',
          warning: 'border-warning/40',
          info: 'border-primary/40',
        },
      }}
    />
  );
};

/** Re-export with an explicit brand namespace so consumers import from @/components/ui. */
export const toast = sonnerToast;
export type { ExternalToast } from 'sonner';
