import React, { useEffect, useRef } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/cn';
import { useFormField } from './FormField';

export const textareaVariants = cva(
  [
    'flex w-full rounded-lg bg-surface text-fg placeholder:text-fg-subtle',
    'border transition-colors duration-fast resize-y',
    'px-3.5 py-2.5 text-body',
    'focus-visible:outline-none focus-visible:shadow-focus focus-visible:border-border-focus',
    'disabled:opacity-50 disabled:cursor-not-allowed disabled:bg-surface-muted',
  ],
  {
    variants: {
      invalid: {
        true: 'border-danger focus-visible:border-danger focus-visible:shadow-[0_0_0_3px_rgb(var(--danger)/0.25)]',
        false: 'border-border hover:border-border-strong',
      },
    },
    defaultVariants: { invalid: false },
  }
);

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    VariantProps<typeof textareaVariants> {
  /** Auto-resize to fit content (removes native resize handle). */
  autoResize?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  (
    {
      className,
      invalid,
      disabled,
      autoResize,
      id: idProp,
      value,
      defaultValue,
      'aria-describedby': ariaDescribedByProp,
      onChange,
      ...props
    },
    forwardedRef
  ) => {
    const field = useFormField();
    const localRef = useRef<HTMLTextAreaElement | null>(null);

    const id = idProp ?? field?.id;
    const effectiveInvalid = invalid ?? field?.invalid ?? false;
    const effectiveDisabled = disabled ?? field?.disabled ?? false;
    const describedBy =
      [ariaDescribedByProp, field?.hintId, field?.errorId].filter(Boolean).join(' ') || undefined;

    // Merge forwarded ref with our local ref
    const setRef = (el: HTMLTextAreaElement | null) => {
      localRef.current = el;
      if (typeof forwardedRef === 'function') forwardedRef(el);
      else if (forwardedRef) (forwardedRef as React.MutableRefObject<HTMLTextAreaElement | null>).current = el;
    };

    const resize = () => {
      const el = localRef.current;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = `${el.scrollHeight}px`;
    };

    useEffect(() => {
      if (autoResize) resize();
    }, [value, autoResize]);

    return (
      <textarea
        ref={setRef}
        id={id}
        disabled={effectiveDisabled}
        aria-invalid={effectiveInvalid || undefined}
        aria-describedby={describedBy}
        value={value}
        defaultValue={defaultValue}
        onChange={(e) => {
          onChange?.(e);
          if (autoResize) resize();
        }}
        className={cn(
          textareaVariants({ invalid: effectiveInvalid }),
          autoResize && 'resize-none overflow-hidden',
          className
        )}
        {...props}
      />
    );
  }
);
Textarea.displayName = 'Textarea';
