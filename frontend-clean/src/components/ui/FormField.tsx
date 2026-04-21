import React, { createContext, useContext, useId } from 'react';
import { cn } from '@/lib/cn';
import { Label } from './Label';

/**
 * FormField — composition primitive that wires up label + input + hint/error
 * with the correct `id` / `htmlFor` / `aria-describedby` / `aria-invalid`
 * relationships.
 *
 * Input / Textarea / Select consume `useFormField()` internally so they pick
 * up the id and error state automatically — consumers don't pass ids.
 *
 * Usage:
 *   <FormField label="Email" hint="We'll never share." error={errors.email} required>
 *     <Input type="email" {...} />
 *   </FormField>
 */

interface FormFieldContextValue {
  id: string;
  hintId: string | undefined;
  errorId: string | undefined;
  invalid: boolean;
  disabled: boolean;
}

const FormFieldContext = createContext<FormFieldContextValue | null>(null);

export const useFormField = (): FormFieldContextValue | null => useContext(FormFieldContext);

export interface FormFieldProps {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  disabled?: boolean;
  /** Override the auto-generated id (rarely needed). */
  id?: string;
  className?: string;
  children: React.ReactNode;
}

export const FormField: React.FC<FormFieldProps> = ({
  label,
  hint,
  error,
  required,
  disabled = false,
  id: idProp,
  className,
  children,
}) => {
  const reactId = useId();
  const id = idProp ?? reactId;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const invalid = Boolean(error);

  return (
    <FormFieldContext.Provider value={{ id, hintId, errorId, invalid, disabled }}>
      <div className={cn('flex flex-col gap-1.5', className)}>
        {label && (
          <Label
            htmlFor={id}
            {...(required ? { required: true } : {})}
            {...(disabled ? { 'aria-disabled': true } : {})}
          >
            {label}
          </Label>
        )}
        {children}
        {error ? (
          <p id={errorId} role="alert" className="text-caption text-danger">
            {error}
          </p>
        ) : hint ? (
          <p id={hintId} className="text-caption text-fg-subtle">
            {hint}
          </p>
        ) : null}
      </div>
    </FormFieldContext.Provider>
  );
};
