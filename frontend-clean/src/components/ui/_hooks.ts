import { useEffect, useRef } from 'react';

/**
 * Internal shared hooks for overlay primitives.
 * Not exported from the barrel — consumers should use Modal/Drawer/Tooltip directly.
 */

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Restore focus to the element that was focused before the overlay opened. */
export const useRestoreFocus = (open: boolean): void => {
  const previouslyFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (open) {
      previouslyFocused.current = document.activeElement as HTMLElement | null;
      return;
    }
    // Closing — restore on next tick so React has unmounted the overlay.
    const el = previouslyFocused.current;
    if (el && typeof el.focus === 'function') {
      queueMicrotask(() => el.focus());
    }
  }, [open]);
};

/** Trap Tab / Shift+Tab cycling within the container while `active`. */
export const useFocusTrap = (
  containerRef: React.RefObject<HTMLElement>,
  active: boolean
): void => {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    // Auto-focus first focusable on mount.
    const focusables = container.querySelectorAll<HTMLElement>(FOCUSABLE);
    const firstInit = focusables[0];
    if (firstInit) {
      firstInit.focus();
    } else {
      container.setAttribute('tabindex', '-1');
      container.focus();
    }

    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const nodes = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !last) {
        e.preventDefault();
        return;
      }
      const activeEl = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [active, containerRef]);
};

/** Invoke `onEscape` when the ESC key is pressed while `active`. */
export const useEscapeKey = (onEscape: () => void, active: boolean): void => {
  useEffect(() => {
    if (!active) return;
    const handle = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onEscape();
      }
    };
    document.addEventListener('keydown', handle);
    return () => document.removeEventListener('keydown', handle);
  }, [active, onEscape]);
};

/** Lock body scroll while any overlay is open. Counts references so nested overlays work. */
let bodyLockCount = 0;
export const useBodyScrollLock = (active: boolean): void => {
  useEffect(() => {
    if (!active) return;
    if (bodyLockCount === 0) {
      const scrollbar = window.innerWidth - document.documentElement.clientWidth;
      document.body.style.overflow = 'hidden';
      if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
    }
    bodyLockCount++;
    return () => {
      bodyLockCount = Math.max(0, bodyLockCount - 1);
      if (bodyLockCount === 0) {
        document.body.style.overflow = '';
        document.body.style.paddingRight = '';
      }
    };
  }, [active]);
};
