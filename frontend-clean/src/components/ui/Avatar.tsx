import React, { useState } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';

/**
 * Avatar — image with graceful fallback to initials. Derives initials from
 * `name` (first letter of each of up to 2 words) when no `src` is provided
 * or image fails to load.
 */

export const avatarVariants = cva(
  ['relative inline-flex items-center justify-center shrink-0 overflow-hidden bg-surface-muted text-fg-muted font-medium select-none'],
  {
    variants: {
      size: {
        xs: 'h-6 w-6 text-[0.625rem]',
        sm: 'h-8 w-8 text-caption',
        md: 'h-10 w-10 text-body-sm',
        lg: 'h-12 w-12 text-body',
        xl: 'h-16 w-16 text-h3',
      },
      shape: {
        circle: 'rounded-full',
        rounded: 'rounded-lg',
      },
    },
    defaultVariants: { size: 'md', shape: 'circle' },
  }
);

const initialsFromName = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('') || '?';

export interface AvatarProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof avatarVariants> {
  src?: string;
  alt?: string;
  name?: string;
}

export const Avatar: React.FC<AvatarProps> = ({
  src,
  alt,
  name,
  size,
  shape,
  className,
  ...props
}) => {
  const [failed, setFailed] = useState(false);
  const showImg = src && !failed;
  return (
    <span className={cn(avatarVariants({ size, shape }), className)} {...props}>
      {showImg ? (
        <img
          src={src}
          alt={alt ?? name ?? ''}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span aria-hidden>{name ? initialsFromName(name) : '?'}</span>
      )}
    </span>
  );
};
