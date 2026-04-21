/** @type {import('tailwindcss').Config} */

// Signal design tokens. Paired with CSS variables declared in src/index.css —
// see docs/DESIGN_TOKENS.md for the rationale and full brief.
// Colors use rgb(var(--*) / <alpha-value>) so opacity utilities (bg-primary/50)
// still work and dark-mode is a single variable swap.

import forms from '@tailwindcss/forms';
import typography from '@tailwindcss/typography';

export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: 'rgb(var(--bg) / <alpha-value>)',
        surface: 'rgb(var(--surface) / <alpha-value>)',
        'surface-muted': 'rgb(var(--surface-muted) / <alpha-value>)',
        'surface-sunken': 'rgb(var(--surface-sunken) / <alpha-value>)',
        'surface-elevated': 'rgb(var(--surface-elevated) / <alpha-value>)',

        fg: 'rgb(var(--fg) / <alpha-value>)',
        'fg-muted': 'rgb(var(--fg-muted) / <alpha-value>)',
        'fg-subtle': 'rgb(var(--fg-subtle) / <alpha-value>)',
        'fg-on-primary': 'rgb(var(--fg-on-primary) / <alpha-value>)',

        border: 'rgb(var(--border) / <alpha-value>)',
        'border-strong': 'rgb(var(--border-strong) / <alpha-value>)',
        'border-focus': 'rgb(var(--border-focus) / <alpha-value>)',

        primary: 'rgb(var(--primary) / <alpha-value>)',
        'primary-hover': 'rgb(var(--primary-hover) / <alpha-value>)',
        'primary-soft': 'rgb(var(--primary-soft) / <alpha-value>)',
        'primary-fg': 'rgb(var(--primary-fg) / <alpha-value>)',

        accent: 'rgb(var(--accent) / <alpha-value>)',

        success: 'rgb(var(--success) / <alpha-value>)',
        'success-soft': 'rgb(var(--success-soft) / <alpha-value>)',
        warning: 'rgb(var(--warning) / <alpha-value>)',
        'warning-soft': 'rgb(var(--warning-soft) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',
        'danger-soft': 'rgb(var(--danger-soft) / <alpha-value>)',
        info: 'rgb(var(--info) / <alpha-value>)',
        'info-soft': 'rgb(var(--info-soft) / <alpha-value>)',
      },

      backgroundImage: {
        'signal-gradient': 'var(--signal-gradient)',
      },

      fontFamily: {
        sans: ['"Inter Variable"', '"Inter"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        display: ['"Inter Variable"', '"Inter"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: [
          '"JetBrains Mono Variable"',
          '"JetBrains Mono"',
          'ui-monospace',
          'SFMono-Regular',
          'Menlo',
          'monospace',
        ],
      },

      // Tuple form: [fontSize, { lineHeight, letterSpacing, fontWeight }]
      fontSize: {
        'display-2xl': ['4.5rem', { lineHeight: '1', letterSpacing: '-0.04em', fontWeight: '700' }],
        'display-xl': ['3.75rem', { lineHeight: '1.05', letterSpacing: '-0.035em', fontWeight: '700' }],
        'display-lg': ['3rem', { lineHeight: '1.1', letterSpacing: '-0.03em', fontWeight: '700' }],

        h1: ['2.25rem', { lineHeight: '1.15', letterSpacing: '-0.025em', fontWeight: '600' }],
        h2: ['1.75rem', { lineHeight: '1.2', letterSpacing: '-0.02em', fontWeight: '600' }],
        h3: ['1.25rem', { lineHeight: '1.3', letterSpacing: '-0.015em', fontWeight: '600' }],
        h4: ['1rem', { lineHeight: '1.4', letterSpacing: '-0.01em', fontWeight: '600' }],

        'body-lg': ['1.0625rem', { lineHeight: '1.55', letterSpacing: '0', fontWeight: '400' }],
        body: ['0.9375rem', { lineHeight: '1.55', letterSpacing: '0', fontWeight: '400' }],
        'body-sm': ['0.8125rem', { lineHeight: '1.5', letterSpacing: '0', fontWeight: '400' }],

        caption: ['0.75rem', { lineHeight: '1.4', letterSpacing: '0.01em', fontWeight: '500' }],
        overline: ['0.6875rem', { lineHeight: '1.3', letterSpacing: '0.08em', fontWeight: '600' }],

        'mono-sm': ['0.8125rem', { lineHeight: '1.5', letterSpacing: '0', fontWeight: '450' }],
        'mono-xs': ['0.6875rem', { lineHeight: '1.4', letterSpacing: '0', fontWeight: '450' }],
      },

      borderRadius: {
        none: '0',
        xs: '2px',
        sm: '4px',
        md: '6px',
        lg: '10px',
        xl: '14px',
        '2xl': '20px',
        '3xl': '28px',
        full: '9999px',
      },

      boxShadow: {
        xs: '0 1px 2px rgb(15 23 42 / 0.04)',
        sm: '0 1px 2px rgb(15 23 42 / 0.04), 0 2px 4px rgb(15 23 42 / 0.03)',
        md: '0 2px 4px rgb(15 23 42 / 0.05), 0 4px 12px rgb(15 23 42 / 0.04)',
        lg: '0 4px 8px rgb(15 23 42 / 0.06), 0 12px 24px rgb(15 23 42 / 0.05)',
        xl: '0 8px 16px rgb(15 23 42 / 0.08), 0 24px 48px rgb(15 23 42 / 0.06)',
        '2xl': '0 16px 32px rgb(15 23 42 / 0.10), 0 40px 80px rgb(15 23 42 / 0.08)',
        focus: '0 0 0 3px rgb(99 102 241 / 0.35)',
        glow: '0 0 0 1px rgb(99 102 241 / 0.30), 0 8px 32px rgb(99 102 241 / 0.20)',
      },

      transitionDuration: {
        micro: '100ms',
        fast: '160ms',
        base: '220ms',
        slow: '320ms',
        hero: '480ms',
      },

      transitionTimingFunction: {
        'out-expo': 'cubic-bezier(0.16, 1, 0.3, 1)',
        'in-quad': 'cubic-bezier(0.55, 0.08, 0.68, 0.53)',
        spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },

      keyframes: {
        'fade-up': {
          from: { opacity: '0', transform: 'translateY(20px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        float: {
          '0%, 100%': { transform: 'translate(0, 0) scale(1)' },
          '33%': { transform: 'translate(30px, -30px) scale(1.05)' },
          '66%': { transform: 'translate(-20px, 20px) scale(0.95)' },
        },
        'pulse-border': {
          '0%': { boxShadow: '0 0 0 0 rgb(99 102 241 / 0.70)' },
          '70%': { boxShadow: '0 0 0 10px rgb(99 102 241 / 0)' },
          '100%': { boxShadow: '0 0 0 0 rgb(99 102 241 / 0)' },
        },
      },

      animation: {
        'fade-up': 'fade-up 0.6s cubic-bezier(0.16, 1, 0.3, 1) both',
        float: 'float 20s ease-in-out infinite',
        'pulse-border': 'pulse-border 2s infinite',
      },
    },
  },
  plugins: [forms, typography],
};
