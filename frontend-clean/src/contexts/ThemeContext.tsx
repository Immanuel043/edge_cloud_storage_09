import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';

/**
 * Theme context — FOUC-free, system-aware.
 *
 * Works in two parts:
 *
 * 1. An inline boot script in `index.html` runs BEFORE this module loads and
 *    adds `.dark` to <html> if the user saved dark mode, or if no preference
 *    is stored AND the OS prefers dark. That script is the authoritative
 *    source of truth on first paint — React must not second-guess it.
 *
 * 2. This provider initializes `darkMode` from the class the boot script
 *    set, so the first React render matches the DOM. After that we only
 *    write to localStorage on an *explicit user toggle* — if the user has
 *    never toggled, we honor live OS changes via `prefers-color-scheme`.
 *
 * See docs/DESIGN_TOKENS.md §7b.
 */

interface ThemeContextValue {
  darkMode: boolean;
  toggleTheme: () => void;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

const STORAGE_KEY = 'theme';

const readInitialDark = (): boolean => {
  if (typeof document === 'undefined') return false;
  return document.documentElement.classList.contains('dark');
};

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [darkMode, setDarkMode] = useState<boolean>(readInitialDark);

  // Apply the class whenever state changes. No localStorage writes here —
  // those only happen on explicit toggle.
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) root.classList.add('dark');
    else root.classList.remove('dark');
  }, [darkMode]);

  // Track OS theme changes for users who haven't explicitly chosen.
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;

    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => {
      // Only follow the OS if the user has not made an explicit choice.
      let stored: string | null = null;
      try {
        stored = localStorage.getItem(STORAGE_KEY);
      } catch (_) { /* storage blocked — ignore */ }
      if (stored == null) setDarkMode(e.matches);
    };

    // Safari < 14 uses addListener; modern browsers use addEventListener.
    if (mql.addEventListener) mql.addEventListener('change', handler);
    else mql.addListener(handler);

    return () => {
      if (mql.removeEventListener) mql.removeEventListener('change', handler);
      else mql.removeListener(handler);
    };
  }, []);

  const toggleTheme = useCallback(() => {
    setDarkMode((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(STORAGE_KEY, next ? 'dark' : 'light');
      } catch (_) { /* storage blocked — theme still applies for this session */ }
      return next;
    });
  }, []);

  return (
    <ThemeContext.Provider value={{ darkMode, toggleTheme }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = (): ThemeContextValue => {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
};
