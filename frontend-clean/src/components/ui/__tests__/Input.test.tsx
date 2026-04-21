import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Input } from '../Input';

describe('Input', () => {
  it('accepts typing', async () => {
    render(<Input placeholder="Email" />);
    const el = screen.getByPlaceholderText('Email') as HTMLInputElement;
    await userEvent.type(el, 'hi');
    expect(el.value).toBe('hi');
  });

  it('passwordReveal toggles input type', async () => {
    render(<Input type="password" passwordReveal defaultValue="secret" />);
    const input = document.querySelector('input') as HTMLInputElement;
    expect(input.type).toBe('password');
    await userEvent.click(screen.getByRole('button', { name: /show password/i }));
    expect(input.type).toBe('text');
    await userEvent.click(screen.getByRole('button', { name: /hide password/i }));
    expect(input.type).toBe('password');
  });

  it('applies aria-invalid when invalid prop is set', () => {
    render(<Input invalid aria-label="Email" />);
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
  });
});
