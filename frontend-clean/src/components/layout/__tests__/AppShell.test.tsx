import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AppShell, MobileMenuButton, useAppShell } from '../AppShell';

// Peek inside the context from a test-only consumer.
const MobileStateProbe: React.FC = () => {
  const { mobileOpen } = useAppShell();
  return <span data-testid="mobile-state">{String(mobileOpen)}</span>;
};

describe('AppShell', () => {
  it('renders sidebar, top bar, and content slots', () => {
    render(
      <AppShell
        sidebar={<div>sidebar-node</div>}
        topBar={<div>topbar-node</div>}
      >
        <div>content-node</div>
      </AppShell>
    );
    expect(screen.getByText('sidebar-node')).toBeInTheDocument();
    expect(screen.getByText('topbar-node')).toBeInTheDocument();
    expect(screen.getByText('content-node')).toBeInTheDocument();
  });

  it('mobile menu toggles context state', async () => {
    render(
      <AppShell
        sidebar={<div>s</div>}
        topBar={
          <div>
            <MobileMenuButton />
            <MobileStateProbe />
          </div>
        }
      >
        <div>c</div>
      </AppShell>
    );
    expect(screen.getByTestId('mobile-state')).toHaveTextContent('false');
    await userEvent.click(screen.getByRole('button', { name: /open navigation menu/i }));
    expect(screen.getByTestId('mobile-state')).toHaveTextContent('true');
  });

  it('useAppShell throws outside <AppShell>', () => {
    const Consumer = () => {
      useAppShell();
      return null;
    };
    // Silence the expected React error boundary log.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Consumer />)).toThrow(/useAppShell must be used inside/);
    spy.mockRestore();
  });
});
