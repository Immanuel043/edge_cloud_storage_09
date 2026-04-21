import React, { useState } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { AlertTriangle, CheckCircle2, Info, ShieldAlert, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { IconButton } from './IconButton';

/**
 * Banner — persistent page-level notice (not a toast). Use for quota warnings,
 * migration notices, offline state, payment reminders. Dismiss via `onDismiss`
 * or let the component self-dismiss via its built-in close button.
 */

export const bannerVariants = cva(
  ['flex items-start gap-3 rounded-lg border p-4 text-body-sm'],
  {
    variants: {
      variant: {
        info: 'border-primary/30 bg-primary/10 text-fg',
        success: 'border-success/30 bg-success/10 text-fg',
        warning: 'border-warning/40 bg-warning/10 text-fg',
        danger: 'border-danger/40 bg-danger/10 text-fg',
      },
    },
    defaultVariants: { variant: 'info' },
  }
);

const iconMap = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  danger: ShieldAlert,
} as const;

const iconColor: Record<keyof typeof iconMap, string> = {
  info: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
};

export interface BannerProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'>,
    VariantProps<typeof bannerVariants> {
  title?: React.ReactNode;
  /** Optional CTA rendered to the right of the text. */
  action?: React.ReactNode;
  /** When provided, a close button is rendered and calls this on dismiss. */
  onDismiss?: () => void;
  /** Override the leading icon (defaults to variant default). */
  icon?: React.ReactNode;
}

export const Banner: React.FC<BannerProps> = ({
  variant = 'info',
  title,
  action,
  onDismiss,
  icon,
  className,
  children,
  ...props
}) => {
  const [dismissed, setDismissed] = useState(false);
  if (dismissed) return null;

  const variantKey = variant ?? 'info';
  const Icon = iconMap[variantKey];

  return (
    <div
      role={variantKey === 'danger' || variantKey === 'warning' ? 'alert' : 'status'}
      className={cn(bannerVariants({ variant }), className)}
      {...props}
    >
      <span className={cn('shrink-0 mt-0.5', iconColor[variantKey])} aria-hidden>
        {icon ?? <Icon className="h-5 w-5" />}
      </span>
      <div className="flex-1 min-w-0">
        {title && <p className="font-medium text-fg">{title}</p>}
        {children && <div className={cn(title && 'mt-1', 'text-fg-muted')}>{children}</div>}
      </div>
      {action && <div className="shrink-0 flex items-center gap-2">{action}</div>}
      {onDismiss && (
        <IconButton
          variant="ghost"
          size="sm"
          className="shrink-0 -mr-1 -mt-1"
          aria-label="Dismiss"
          onClick={() => {
            setDismissed(true);
            onDismiss();
          }}
        >
          <X />
        </IconButton>
      )}
    </div>
  );
};
