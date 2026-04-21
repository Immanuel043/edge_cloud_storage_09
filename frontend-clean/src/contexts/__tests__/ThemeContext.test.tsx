/**
 * ThemeContext — FOUC-free, system-aware behavior.
 *
 * Verifies:
 *   (a) first render matches the DOM class set by the boot script
 *   (b) toggling writes to localStorage
 *   (c) a system-setting change propagates when no localStorage value exists
 *       and is ignored when one does
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme } from '../ThemeContext';

const Probe: React.FC = () => {
  const { darkMode, toggleTheme } = useTheme();
  return (
    <>
      <span data-testid="mode">{darkMode ? 'dark' : 'light'}</span>
      <button onClick={toggleTheme}>toggle</button>
    </>
  );
};

type MqlListener = (e: MediaQueryListEvent) => void;

const installMatchMedia = (initialMatches: boolean) => {
  const listeners: MqlListener[] = [];
  const mql = {
    matches: initialMatches,
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_: string, l: MqlListener) => { listeners.push(l); },
    removeEventListener: (_: string, l: MqlListener) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
    addListener: (l: MqlListener) => { listeners.push(l); },
    removeListener: (l: MqlListener) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
    dispatchEvent: () => false,
  } as unknown as MediaQueryList;

  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockReturnValue(mql),
  });

  return {
    emit: (matches: boolean) => {
      (mql as unknown as { matches: boolean }).matches = matches;
      listeners.forEach((l) => l({ matches } as MediaQueryListEvent));
    },
  };
};

describe('ThemeContext', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove('dark');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('(a) first render matches DOM class set by boot script (dark)', () => {
    // Simulate boot script having added .dark
    document.documentElement.classList.add('dark');
    installMatchMedia(false);

    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('mode').textContent).toBe('dark');
  });

  it('(a) first render matches DOM class set by boot script (light)', () => {
    installMatchMedia(false);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('mode').textContent).toBe('light');
  });

  it('(b) toggling writes to localStorage and flips the html class', () => {
    installMatchMedia(false);
    render(<ThemeProvider><Probe /></ThemeProvider>);

    expect(screen.getByTestId('mode').textContent).toBe('light');
    expect(localStorage.getItem('theme')).toBeNull();

    // user-event v13 API — direct call, no setup()
    userEvent.click(screen.getByText('toggle'));

    expect(screen.getByTestId('mode').textContent).toBe('dark');
    expect(localStorage.getItem('theme')).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it('(c) system change propagates when no explicit user choice is stored', () => {
    const mm = installMatchMedia(false);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('mode').textContent).toBe('light');

    act(() => { mm.emit(true); });
    expect(screen.getByTestId('mode').textContent).toBe('dark');
  });

  it('(c) system change is ignored when an explicit user choice exists', () => {
    localStorage.setItem('theme', 'light');
    const mm = installMatchMedia(false);
    render(<ThemeProvider><Probe /></ThemeProvider>);
    expect(screen.getByTestId('mode').textContent).toBe('light');

    act(() => { mm.emit(true); });
    // User picked light → OS flip to dark must NOT override.
    expect(screen.getByTestId('mode').textContent).toBe('light');
  });
});
