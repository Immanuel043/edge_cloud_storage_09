import React, { useId, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * Tooltip — lightweight hover/focus hint. Not portaled (positioned absolutely
 * within a relative wrapper) — sufficient for nav items and icon buttons.
 * Respects keyboard focus + `prefers-reduced-motion`. For rich dropdowns use
 * DropdownMenu instead.
 *
 *   <Tooltip content="Upload files" side="bottom">
 *     <IconButton aria-label="Upload"><Upload /></IconButton>
 *   </Tooltip>
 */

type TooltipSide = 'top' | 'right' | 'bottom' | 'left';

const sideClass: Record<TooltipSide, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
  left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
  right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
};

export interface TooltipProps {
  content: React.ReactNode;
  side?: TooltipSide;
  /** Delay in ms before showing on hover. Default 200. */
  delay?: number;
  /** Disable the tooltip entirely (passes through). */
  disabled?: boolean;
  className?: string;
  children: React.ReactElement<any>;
}

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  side = 'top',
  delay = 200,
  disabled,
  className,
  children,
}) => {
  const [visible, setVisible] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const id = useId();

  if (disabled) return children;

  const show = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => setVisible(true), delay);
  };
  const hide = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setVisible(false);
  };

  const childProps: Record<string, unknown> = children.props;
  const fire = <E,>(key: string, arg: E) =>
    (childProps[key] as ((e: E) => void) | undefined)?.(arg);

  const trigger = React.cloneElement(children, {
    'aria-describedby': visible ? id : undefined,
    onMouseEnter: (e: React.MouseEvent) => {
      fire('onMouseEnter', e);
      show();
    },
    onMouseLeave: (e: React.MouseEvent) => {
      fire('onMouseLeave', e);
      hide();
    },
    onFocus: (e: React.FocusEvent) => {
      fire('onFocus', e);
      show();
    },
    onBlur: (e: React.FocusEvent) => {
      fire('onBlur', e);
      hide();
    },
  } as Record<string, unknown>);

  return (
    <span className="relative inline-flex">
      {trigger}
      {visible && (
        <span
          role="tooltip"
          id={id}
          className={cn(
            'pointer-events-none absolute z-50 whitespace-nowrap rounded-md',
            'bg-fg text-bg px-2 py-1 text-caption shadow-md',
            'animate-fade-up',
            sideClass[side],
            className
          )}
        >
          {content}
        </span>
      )}
    </span>
  );
};
