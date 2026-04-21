import React, { createContext, useContext, useId } from 'react';
import { cn } from '@/lib/cn';

/**
 * Tabs — controlled or uncontrolled horizontal tab strip with two visual
 * variants. Use `pill` for filter/segmented-control feel, `underline` for
 * primary page tabs.
 *
 *   <Tabs value={tab} onChange={setTab}>
 *     <TabsList>
 *       <TabsTrigger value="overview">Overview</TabsTrigger>
 *       <TabsTrigger value="billing">Billing</TabsTrigger>
 *     </TabsList>
 *     <TabsContent value="overview">...</TabsContent>
 *     <TabsContent value="billing">...</TabsContent>
 *   </Tabs>
 */

type TabsVariant = 'underline' | 'pill';

interface TabsContextValue {
  value: string;
  setValue: (v: string) => void;
  variant: TabsVariant;
  baseId: string;
}

const TabsContext = createContext<TabsContextValue | null>(null);
const useTabs = () => {
  const ctx = useContext(TabsContext);
  if (!ctx) throw new Error('Tabs subcomponent used outside <Tabs>');
  return ctx;
};

export interface TabsProps {
  value: string;
  onChange: (v: string) => void;
  variant?: TabsVariant;
  className?: string;
  children: React.ReactNode;
}

export const Tabs: React.FC<TabsProps> = ({
  value,
  onChange,
  variant = 'underline',
  className,
  children,
}) => {
  const baseId = useId();
  return (
    <TabsContext.Provider value={{ value, setValue: onChange, variant, baseId }}>
      <div className={cn('flex flex-col gap-4', className)}>{children}</div>
    </TabsContext.Provider>
  );
};

export const TabsList: React.FC<React.HTMLAttributes<HTMLDivElement>> = ({
  className,
  children,
  onKeyDown,
  ...props
}) => {
  const { variant } = useTabs();

  const handleKey: React.KeyboardEventHandler<HTMLDivElement> = (e) => {
    onKeyDown?.(e);
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const list = e.currentTarget;
    const tabs = Array.from(
      list.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])')
    );
    if (tabs.length === 0) return;
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? tabs.indexOf(active as HTMLButtonElement) : -1;
    const focusAt = (n: number) =>
      tabs[((n % tabs.length) + tabs.length) % tabs.length]?.focus();
    e.preventDefault();
    if (e.key === 'ArrowRight') focusAt(idx + 1);
    else if (e.key === 'ArrowLeft') focusAt(idx - 1);
    else if (e.key === 'Home') tabs[0]?.focus();
    else if (e.key === 'End') tabs[tabs.length - 1]?.focus();
  };

  return (
    <div
      role="tablist"
      onKeyDown={handleKey}
      className={cn(
        'flex items-center gap-1',
        variant === 'underline' && 'border-b border-border',
        variant === 'pill' && 'p-1 rounded-lg bg-surface-muted w-fit',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

export interface TabsTriggerProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export const TabsTrigger: React.FC<TabsTriggerProps> = ({
  value,
  className,
  children,
  ...props
}) => {
  const { value: active, setValue, variant, baseId } = useTabs();
  const isActive = active === value;
  return (
    <button
      type="button"
      role="tab"
      id={`${baseId}-tab-${value}`}
      aria-controls={`${baseId}-panel-${value}`}
      aria-selected={isActive}
      tabIndex={isActive ? 0 : -1}
      onClick={() => setValue(value)}
      className={cn(
        'inline-flex items-center gap-2 px-4 py-2 text-body-sm font-medium transition-colors duration-fast',
        'focus-visible:outline-none focus-visible:shadow-focus',
        variant === 'underline' &&
          'border-b-2 -mb-px border-transparent text-fg-muted hover:text-fg',
        variant === 'underline' && isActive && 'border-primary text-fg',
        variant === 'pill' && 'rounded-md text-fg-muted hover:text-fg',
        variant === 'pill' && isActive && 'bg-surface text-fg shadow-sm',
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
};

export interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
}

export const TabsContent: React.FC<TabsContentProps> = ({
  value,
  className,
  children,
  ...props
}) => {
  const { value: active, baseId } = useTabs();
  if (active !== value) return null;
  return (
    <div
      role="tabpanel"
      id={`${baseId}-panel-${value}`}
      aria-labelledby={`${baseId}-tab-${value}`}
      className={className}
      {...props}
    >
      {children}
    </div>
  );
};
