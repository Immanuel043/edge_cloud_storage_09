// Barrel export for app layout primitives — Phase 3 of the UI redesign.
// Consumers should `import { AppShell, TopBar, Sidebar, NavItem } from '@/components/layout'`.

export { AppShell, MobileMenuButton, ContentContainer, useAppShell } from './AppShell';
export type { AppShellProps } from './AppShell';

export { TopBar } from './TopBar';
export type { TopBarProps } from './TopBar';

export { Sidebar, MobileSidebar } from './Sidebar';
export type { SidebarProps, MobileSidebarProps } from './Sidebar';

export { SidebarBrand } from './SidebarBrand';
export type { SidebarBrandProps } from './SidebarBrand';

export { NavItem, NavSection } from './NavItem';
export type { NavItemProps, NavSectionProps } from './NavItem';
