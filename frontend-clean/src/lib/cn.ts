import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

const customTwMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'display-2xl',
            'display-xl',
            'display-lg',
            'h1',
            'h2',
            'h3',
            'h4',
            'body-lg',
            'body',
            'body-sm',
            'caption',
            'overline',
            'mono-sm',
            'mono-xs',
          ],
        },
      ],
      'text-color': [
        {
          text: [
            'fg',
            'fg-muted',
            'fg-subtle',
            'fg-on-primary',
            'primary',
            'primary-hover',
            'primary-soft',
            'primary-fg',
            'accent',
            'success',
            'success-soft',
            'warning',
            'warning-soft',
            'danger',
            'danger-soft',
            'info',
            'info-soft',
          ],
        },
      ],
    },
  },
});

/**
 * Merge Tailwind classes with conflict-resolution.
 *
 * Use throughout the `ui/` primitives and in consumer components instead of
 * inline template-literal className strings. `twMerge` resolves conflicts
 * (e.g. `px-4 px-6` → `px-6`), `clsx` handles conditional / array / object
 * inputs. Extended so custom design-token classes (`text-body-lg`,
 * `text-primary-fg`, etc.) are classified into the correct groups instead of
 * collapsing against each other.
 */
export const cn = (...inputs: ClassValue[]): string => customTwMerge(clsx(inputs));
