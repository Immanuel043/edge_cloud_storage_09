import React from 'react';
import { cn } from '@/lib/cn';

/**
 * Table — structural primitives wrapping native <table>. All subcomponents
 * forward native props; pass `onClick` to TableRow for selectable rows.
 */

export const Table = React.forwardRef<HTMLTableElement, React.TableHTMLAttributes<HTMLTableElement>>(
  ({ className, ...props }, ref) => (
    <div className="w-full overflow-x-auto">
      <table
        ref={ref}
        className={cn('w-full border-collapse text-body-sm text-fg', className)}
        {...props}
      />
    </div>
  )
);
Table.displayName = 'Table';

export const TableHeader: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({
  className,
  ...props
}) => (
  <thead
    className={cn(
      'bg-surface-muted text-caption font-semibold text-fg-muted uppercase tracking-wide',
      className
    )}
    {...props}
  />
);

export const TableBody: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({
  className,
  ...props
}) => <tbody className={cn('divide-y divide-border', className)} {...props} />;

export const TableFooter: React.FC<React.HTMLAttributes<HTMLTableSectionElement>> = ({
  className,
  ...props
}) => (
  <tfoot
    className={cn('border-t border-border bg-surface-muted text-fg-muted', className)}
    {...props}
  />
);

export interface TableRowProps extends React.HTMLAttributes<HTMLTableRowElement> {
  /** Whether hovering highlights the row. Default true for <tbody> rows. */
  hover?: boolean;
  selected?: boolean;
}

export const TableRow: React.FC<TableRowProps> = ({
  className,
  hover = true,
  selected,
  ...props
}) => (
  <tr
    aria-selected={selected || undefined}
    className={cn(
      'transition-colors duration-fast',
      hover && 'hover:bg-surface-muted',
      selected && 'bg-primary/5',
      className
    )}
    {...props}
  />
);

export const TableHead: React.FC<React.ThHTMLAttributes<HTMLTableCellElement>> = ({
  className,
  ...props
}) => (
  <th
    className={cn('h-10 px-4 text-left align-middle font-semibold', className)}
    {...props}
  />
);

export const TableCell: React.FC<React.TdHTMLAttributes<HTMLTableCellElement>> = ({
  className,
  ...props
}) => <td className={cn('px-4 py-3 align-middle', className)} {...props} />;
