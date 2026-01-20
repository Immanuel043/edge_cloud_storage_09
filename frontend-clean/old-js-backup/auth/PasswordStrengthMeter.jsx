import React from 'react';
import { Check, X } from 'lucide-react';

/**
 * PasswordStrengthMeter Component
 *
 * Displays a visual password strength indicator with requirement checklist.
 *
 * @param {Object} props
 * @param {Object} props.strengthData - Output from validatePasswordStrength()
 * @param {boolean} props.darkMode - Dark mode toggle
 * @param {boolean} props.showRequirements - Whether to show requirements list (default: true)
 */
export default function PasswordStrengthMeter({ strengthData, darkMode, showRequirements = true }) {
  if (!strengthData) return null;

  const { score, strength, requirements } = strengthData;

  // Color based on strength
  const getStrengthColor = () => {
    switch (strength) {
      case 'strong': return 'bg-green-500';
      case 'good': return 'bg-blue-500';
      case 'fair': return 'bg-yellow-500';
      case 'weak': return 'bg-red-500';
      default: return 'bg-gray-400';
    }
  };

  const getStrengthTextColor = () => {
    switch (strength) {
      case 'strong': return darkMode ? 'text-green-400' : 'text-green-600';
      case 'good': return darkMode ? 'text-blue-400' : 'text-blue-600';
      case 'fair': return darkMode ? 'text-yellow-400' : 'text-yellow-600';
      case 'weak': return darkMode ? 'text-red-400' : 'text-red-600';
      default: return darkMode ? 'text-gray-400' : 'text-gray-600';
    }
  };

  const requirementsList = [
    { key: 'minLength', label: '8+ characters' },
    { key: 'hasUppercase', label: 'Uppercase letter' },
    { key: 'hasLowercase', label: 'Lowercase letter' },
    { key: 'hasNumber', label: 'Number' },
    { key: 'hasSpecial', label: 'Special character' },
  ];

  return (
    <div className="mt-2 space-y-2">
      {/* Strength Bar */}
      <div className="flex items-center gap-2">
        <div className={`flex-1 h-1.5 rounded-full ${darkMode ? 'bg-gray-700' : 'bg-gray-200'} overflow-hidden`}>
          <div
            className={`h-full rounded-full transition-all duration-300 ${getStrengthColor()}`}
            style={{ width: `${(score / 4) * 100}%` }}
          />
        </div>
        <span className={`text-xs font-medium capitalize ${getStrengthTextColor()}`}>
          {strength}
        </span>
      </div>

      {/* Requirements List */}
      {showRequirements && (
        <div className="grid grid-cols-2 gap-1">
          {requirementsList.map(({ key, label }) => (
            <div
              key={key}
              className={`flex items-center gap-1.5 text-xs ${
                requirements[key]
                  ? darkMode ? 'text-green-400' : 'text-green-600'
                  : darkMode ? 'text-gray-500' : 'text-gray-400'
              }`}
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
}
