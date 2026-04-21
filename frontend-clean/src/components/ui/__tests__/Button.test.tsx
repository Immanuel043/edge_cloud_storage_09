import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from '../Button';

describe('Button', () => {
  it('renders children and fires onClick', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('applies variant classes', () => {
    const { rerender } = render(<Button variant="primary">x</Button>);
    const btn = screen.getByRole('button');
    // primary variant maps to the signal gradient or primary bg — exact class
    // isn't asserted, but the cva output must be non-empty.
    expect(btn.className.length).toBeGreaterThan(0);
    rerender(<Button variant="destructive">x</Button>);
    expect(btn.className).toContain('danger');
  });

  it('loading state disables click and shows spinner', async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Save
      </Button>
    );
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(btn).toBeDisabled();
    // Spinner has role="status"
    expect(screen.getByRole('status')).toBeInTheDocument();
    await userEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('respects disabled prop', () => {
    render(<Button disabled>x</Button>);
    expect(screen.getByRole('button')).toBeDisabled();
  });
});
