import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FormField } from '../FormField';
import { Input } from '../Input';

describe('FormField', () => {
  it('wires label → input via id and marks the asterisk when required', () => {
    render(
      <FormField label="Email" required>
        <Input type="email" />
      </FormField>
    );
    const input = screen.getByLabelText(/email/i) as HTMLInputElement;
    expect(input.id).toBeTruthy();
    expect(input.id.length).toBeGreaterThan(0);
    // required asterisk rendered (aria-hidden, but visible text)
    expect(screen.getByText('*')).toBeInTheDocument();
  });

  it('propagates error to aria-invalid + aria-describedby on the child input', () => {
    render(
      <FormField label="Email" error="Required field">
        <Input />
      </FormField>
    );
    const input = screen.getByLabelText(/email/i) as HTMLInputElement;
    expect(input).toHaveAttribute('aria-invalid', 'true');
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const errorEl = document.getElementById(describedBy!);
    expect(errorEl).toHaveTextContent('Required field');
    expect(errorEl).toHaveAttribute('role', 'alert');
  });

  it('renders hint and wires aria-describedby when no error', () => {
    render(
      <FormField label="Username" hint="3-20 chars">
        <Input />
      </FormField>
    );
    const input = screen.getByLabelText(/username/i);
    const describedBy = input.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent('3-20 chars');
  });
});
