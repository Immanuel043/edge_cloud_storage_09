// Signal UI primitives — barrel export.
// Consumers should `import { Button, Input, ... } from '@/components/ui'`.

export { Spinner } from './Spinner';
export type { SpinnerProps } from './Spinner';

export { Button, buttonVariants } from './Button';
export type { ButtonProps } from './Button';

export { IconButton, iconButtonVariants } from './IconButton';
export type { IconButtonProps } from './IconButton';

export { Label } from './Label';
export type { LabelProps } from './Label';

export { FormField, useFormField } from './FormField';
export type { FormFieldProps } from './FormField';

export { Input, inputVariants } from './Input';
export type { InputProps } from './Input';

export { Textarea, textareaVariants } from './Textarea';
export type { TextareaProps } from './Textarea';

export { Select, selectVariants } from './Select';
export type { SelectProps } from './Select';

export { Checkbox } from './Checkbox';
export type { CheckboxProps } from './Checkbox';

export { Switch } from './Switch';
export type { SwitchProps } from './Switch';

export { Radio, RadioGroup } from './Radio';
export type { RadioProps, RadioGroupProps } from './Radio';

// Overlays
export { Modal, ModalHeader, ModalBody, ModalFooter } from './Modal';
export type { ModalProps } from './Modal';

export { ConfirmModal } from './ConfirmModal';
export type { ConfirmModalProps, ConfirmModalVariant } from './ConfirmModal';

export { Drawer } from './Drawer';
export type { DrawerProps } from './Drawer';

export { Tooltip } from './Tooltip';
export type { TooltipProps } from './Tooltip';

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from './DropdownMenu';
export type {
  DropdownMenuTriggerProps,
  DropdownMenuContentProps,
  DropdownMenuItemProps,
} from './DropdownMenu';

export { Toaster, toast } from './Toast';
export type { ToasterProps, ExternalToast } from './Toast';

// Feedback + display
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  cardVariants,
} from './Card';
export type { CardProps } from './Card';

export { Badge, badgeVariants } from './Badge';
export type { BadgeProps } from './Badge';

export { Skeleton } from './Skeleton';
export type { SkeletonProps } from './Skeleton';

export { Tabs, TabsList, TabsTrigger, TabsContent } from './Tabs';
export type { TabsProps, TabsTriggerProps, TabsContentProps } from './Tabs';

export { Progress, progressVariants } from './Progress';
export type { ProgressProps } from './Progress';

export { EmptyState } from './EmptyState';
export type { EmptyStateProps } from './EmptyState';

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableRow,
  TableHead,
  TableCell,
} from './Table';
export type { TableRowProps } from './Table';

export { Avatar, avatarVariants } from './Avatar';
export type { AvatarProps } from './Avatar';

export { Banner, bannerVariants } from './Banner';
export type { BannerProps } from './Banner';
