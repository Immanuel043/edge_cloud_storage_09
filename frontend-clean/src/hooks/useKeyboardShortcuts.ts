import { useEffect, useRef } from 'react';
import type { KeyboardShortcuts } from '../types/hooks.types';

export const useKeyboardShortcuts = (shortcuts: KeyboardShortcuts): void => {
  // Store shortcuts in a ref so the event listener doesn't need to be
  // re-registered when the shortcuts object is recreated each render
  const shortcutsRef = useRef(shortcuts);
  shortcutsRef.current = shortcuts;

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      const currentShortcuts = shortcutsRef.current;
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
      if (currentShortcuts[keyCombo]) {
        event.preventDefault();
        currentShortcuts[keyCombo](event);
      } else {
        // Check for simpler versions (just the key)
        const simpleKey = event.key.toLowerCase();
        if (currentShortcuts[simpleKey]) {
          // Don't prevent default for simple keys unless in input
          if (
            event.target instanceof HTMLElement &&
            event.target.tagName !== 'INPUT' &&
            event.target.tagName !== 'TEXTAREA'
          ) {
            event.preventDefault();
            currentShortcuts[simpleKey](event);
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, []);
};
