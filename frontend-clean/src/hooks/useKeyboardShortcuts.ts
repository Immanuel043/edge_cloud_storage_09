import { useEffect, useCallback } from 'react';
import type { KeyboardShortcuts } from '../types/hooks.types';

export const useKeyboardShortcuts = (shortcuts: KeyboardShortcuts): void => {
  const handleKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      // Build the key combination string
      const keyCombo = [
        event.ctrlKey && 'ctrl',
        event.shiftKey && 'shift',
        event.altKey && 'alt',
        event.metaKey && 'meta',
        event.key.toLowerCase(),
      ]
        .filter(Boolean)
        .join('+');

      // Check if we have a handler for this combination
      if (shortcuts[keyCombo]) {
        event.preventDefault();
        shortcuts[keyCombo](event);
      } else {
        // Check for simpler versions (just the key)
        const simpleKey = event.key.toLowerCase();
        if (shortcuts[simpleKey]) {
          // Don't prevent default for simple keys unless in input
          if (
            event.target instanceof HTMLElement &&
            event.target.tagName !== 'INPUT' &&
            event.target.tagName !== 'TEXTAREA'
          ) {
            event.preventDefault();
            shortcuts[simpleKey](event);
          }
        }
      }
    },
    [shortcuts]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleKeyDown]);
};
