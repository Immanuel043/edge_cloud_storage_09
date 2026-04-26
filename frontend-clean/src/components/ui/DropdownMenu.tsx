import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

/**
 * DropdownMenu — portal-positioned menu with keyboard navigation.
 *
 *   <DropdownMenu>
 *     <DropdownMenuTrigger asChild>
 *       <IconButton aria-label="Actions"><MoreVertical /></IconButton>
 *     </DropdownMenuTrigger>
 *     <DropdownMenuContent align="end">
 *       <DropdownMenuItem onSelect={doShare}>Share</DropdownMenuItem>
 *       <DropdownMenuSeparator />
 *       <DropdownMenuItem variant="destructive" onSelect={doDelete}>Delete</DropdownMenuItem>
 *     </DropdownMenuContent>
 *   </DropdownMenu>
 */

interface DropdownMenuContextValue {
  open: boolean;
  setOpen: (v: boolean) => void;
  triggerRef: React.MutableRefObject<HTMLElement | null>;
  contentId: string;
}

const DropdownMenuContext = createContext<DropdownMenuContextValue | null>(null);

const useDropdown = () => {
  const ctx = useContext(DropdownMenuContext);
  if (!ctx) throw new Error('DropdownMenu subcomponent used outside <DropdownMenu>');
  return ctx;
};

export const DropdownMenu: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLElement>(null);
  const contentId = useId();
  return (
    <DropdownMenuContext.Provider value={{ open, setOpen, triggerRef, contentId }}>
      {children}
    </DropdownMenuContext.Provider>
  );
};

export interface DropdownMenuTriggerProps {
  asChild?: boolean;
  children: React.ReactElement<any>;
}

export const DropdownMenuTrigger: React.FC<DropdownMenuTriggerProps> = ({ children }) => {
  const { open, setOpen, triggerRef, contentId } = useDropdown();
  const childProps: Record<string, unknown> = children.props;
  return React.cloneElement(children, {
    ref: (el: HTMLElement | null) => {
      triggerRef.current = el;
    },
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? contentId : undefined,
    onClick: (e: React.MouseEvent) => {
      (childProps.onClick as ((e: React.MouseEvent) => void) | undefined)?.(e);
      setOpen(!open);
    },
  } as Record<string, unknown>);
};

type Align = 'start' | 'center' | 'end';

const VIEWPORT_PADDING = 8;

interface DropdownPosition {
  top: number;
  left: number;
  maxHeight: number;
  transformOrigin: string;
}

export interface DropdownMenuContentProps {
  align?: Align;
  sideOffset?: number;
  className?: string;
  children: React.ReactNode;
}

export const DropdownMenuContent: React.FC<DropdownMenuContentProps> = ({
  align = 'start',
  sideOffset = 6,
  className,
  children,
}) => {
  const { open, setOpen, triggerRef, contentId } = useDropdown();
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<DropdownPosition | null>(null);

  // Compute anchored position relative to viewport.
  useLayoutEffect(() => {
    if (!open) return;
    const updatePosition = () => {
      const trigger = triggerRef.current;
      const menu = menuRef.current;
      if (!trigger || !menu) return;

      const rect = trigger.getBoundingClientRect();
      const menuRect = menu.getBoundingClientRect();

      let left = rect.left;
      if (align === 'center') left = rect.left + rect.width / 2 - menuRect.width / 2;
      if (align === 'end') left = rect.right - menuRect.width;
      left = Math.max(
        VIEWPORT_PADDING,
        Math.min(left, window.innerWidth - menuRect.width - VIEWPORT_PADDING)
      );

      const spaceBelow = window.innerHeight - rect.bottom - sideOffset - VIEWPORT_PADDING;
      const spaceAbove = rect.top - sideOffset - VIEWPORT_PADDING;
      const shouldOpenAbove = menuRect.height > spaceBelow && spaceAbove > spaceBelow;
      const availableHeight = Math.max(
        VIEWPORT_PADDING,
        shouldOpenAbove ? spaceAbove : spaceBelow
      );
      const renderedHeight = Math.min(menuRect.height, availableHeight);
      const top = shouldOpenAbove
        ? Math.max(VIEWPORT_PADDING, rect.top - sideOffset - renderedHeight)
        : Math.min(
            rect.bottom + sideOffset,
            window.innerHeight - renderedHeight - VIEWPORT_PADDING
          );

      setPos({
        top,
        left,
        maxHeight: availableHeight,
        transformOrigin: shouldOpenAbove ? 'bottom right' : 'top right',
      });
    };

    // Render once at the trigger so the menu can be measured, then settle it
    // before paint. This prevents edge menus from flashing off-screen.
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    setPos({
      top: Math.min(rect.bottom + sideOffset, window.innerHeight - VIEWPORT_PADDING),
      left: Math.max(VIEWPORT_PADDING, Math.min(rect.left, window.innerWidth - VIEWPORT_PADDING)),
      maxHeight: Math.max(VIEWPORT_PADDING, window.innerHeight - VIEWPORT_PADDING * 2),
      transformOrigin: 'top right',
    });

    const raf = requestAnimationFrame(() => {
      updatePosition();
      // Move focus to first enabled menuitem so ArrowUp/Down + Enter work.
      const firstItem = menuRef.current?.querySelector<HTMLElement>(
        '[role="menuitem"]:not([aria-disabled="true"])'
      );
      firstItem?.focus();
    });

    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, align, sideOffset, triggerRef]);

  // Click-outside + ESC dismissal.
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      const menu = menuRef.current;
      const trigger = triggerRef.current;
      const target = e.target as Node;
      if (menu?.contains(target) || trigger?.contains(target)) return;
      setOpen(false);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open, setOpen, triggerRef]);

  // Keyboard arrow navigation over DropdownMenuItem children.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const items = Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([aria-disabled="true"])') ?? []
      );
      if (items.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? items.indexOf(active) : -1;
      const focusAt = (n: number) => items[((n % items.length) + items.length) % items.length]?.focus();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        focusAt(idx + 1);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        focusAt(idx - 1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        items[0]?.focus();
      } else if (e.key === 'End') {
        e.preventDefault();
        items[items.length - 1]?.focus();
      }
    },
    []
  );

  if (!open || !pos) return null;
  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={menuRef}
      id={contentId}
      role="menu"
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        top: pos.top,
        left: pos.left,
        maxHeight: pos.maxHeight,
        transformOrigin: pos.transformOrigin,
      }}
      className={cn(
        'z-[200] min-w-[12rem] overflow-y-auto rounded-lg border border-border bg-surface-elevated p-1 shadow-lg',
        'animate-fade-up',
        className
      )}
    >
      {children}
    </div>,
    document.body
  );
};

export interface DropdownMenuItemProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'> {
  variant?: 'default' | 'destructive';
  /** Called when the item is activated (click or Enter). The menu closes after. */
  onSelect?: () => void;
  /** Leading icon slot. */
  icon?: React.ReactNode;
}

export const DropdownMenuItem = React.forwardRef<HTMLButtonElement, DropdownMenuItemProps>(
  ({ className, variant = 'default', onSelect, icon, children, disabled, ...props }, ref) => {
    const { setOpen } = useDropdown();
    return (
      <button
        ref={ref}
        type="button"
        role="menuitem"
        aria-disabled={disabled || undefined}
        disabled={disabled}
        onClick={() => {
          if (disabled) return;
          onSelect?.();
          setOpen(false);
        }}
        className={cn(
          'flex w-full items-center gap-2 rounded-md px-3 py-2 text-body-sm text-left',
          'transition-colors duration-fast',
          'hover:bg-surface-muted focus:bg-surface-muted focus:outline-none',
          variant === 'destructive' && 'text-danger hover:bg-danger/10 focus:bg-danger/10',
          'disabled:opacity-50 disabled:pointer-events-none',
          className
        )}
        {...props}
      >
        {icon && <span className="shrink-0 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>}
        <span className="flex-1 truncate">{children}</span>
      </button>
    );
  }
);
DropdownMenuItem.displayName = 'DropdownMenuItem';

export const DropdownMenuSeparator: React.FC<React.HTMLAttributes<HTMLHRElement>> = ({
  className,
  ...props
}) => <hr className={cn('my-1 border-0 border-t border-border', className)} {...props} />;

export const DropdownMenuLabel: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  ...props
}) => (
  <div
    className={cn('px-3 py-1.5 text-caption font-semibold text-fg-subtle uppercase tracking-wide', className)}
    {...props}
  >
    {children}
  </div>
);
