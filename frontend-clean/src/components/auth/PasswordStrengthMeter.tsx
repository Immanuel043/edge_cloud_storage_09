import React from 'react';
import { Check, X } from 'lucide-react';
import type { PasswordStrengthMeterProps } from './types';
import type { PasswordRequirements } from '../../utils/security';
import { cn } from '@/lib/cn';

interface RequirementItem {
  key: keyof PasswordRequirements;
  label: string;
}

/**
 * PasswordStrengthMeter — horizontal strength bar plus a checklist of the
 * five password requirements. Score maps to a tone (weak/fair/good/strong).
 */
const PasswordStrengthMeter: React.FC<PasswordStrengthMeterProps> = ({
  strengthData,
  showRequirements = true,
}) => {
  if (!strengthData) return null;

  const { score, strength, requirements } = strengthData;

  const strengthBarClass: Record<string, string> = {
    strong: 'bg-success',
    good: 'bg-primary',
    fair: 'bg-warning',
    weak: 'bg-danger',
  };

  const strengthTextClass: Record<string, string> = {
    strong: 'text-success',
    good: 'text-primary',
    fair: 'text-warning',
    weak: 'text-danger',
  };

  const requirementsList: RequirementItem[] = [
    { key: 'minLength', label: '8+ characters' },
    { key: 'hasUppercase', label: 'Uppercase letter' },
    { key: 'hasLowercase', label: 'Lowercase letter' },
    { key: 'hasNumber', label: 'Number' },
    { key: 'hasSpecial', label: 'Special character' },
  ];

  return (
    <div className="mt-2 space-y-2">
      <div className="flex items-center gap-2">
        <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-muted">
          <div
            className={cn(
              'h-full rounded-full transition-all duration-normal',
              strengthBarClass[strength] ?? 'bg-fg-subtle'
            )}
            style={{ width: `${(score / 4) * 100}%` }}
          />
        </div>
        <span
          className={cn(
            'text-caption font-medium capitalize',
            strengthTextClass[strength] ?? 'text-fg-muted'
          )}
        >
          {strength}
        </span>
      </div>

      {showRequirements && (
        <div className="grid grid-cols-2 gap-1">
          {requirementsList.map(({ key, label }) => (
            <div
              key={key}
              className={cn(
                'flex items-center gap-1.5 text-caption',
                requirements[key] ? 'text-success' : 'text-fg-subtle'
              )}
            >
              {requirements[key] ? (
                <Check size={12} className="flex-shrink-0" />
              ) : (
                <X size={12} className="flex-shrink-0" />
              )}
              <span>{label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default PasswordStrengthMeter;
