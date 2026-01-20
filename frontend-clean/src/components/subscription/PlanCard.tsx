import { type ReactElement } from 'react';
import { Check, Crown, HardDrive, Gauge } from 'lucide-react';
import type { PlanCardProps, FeatureObject } from '../../types/subscription-components.types';

/**
 * PlanCard
 *
 * Displays a subscription plan with pricing, features, and action button.
 *
 * Props:
 * - plan: Plan object from API
 * - isCurrent: Whether this is the user's current plan
 * - onSelect: Callback when plan is selected
 * - disabled: Whether the card is disabled
 */
export default function PlanCard({
  plan,
  isCurrent = false,
  onSelect,
  disabled = false,
}: PlanCardProps): ReactElement {
  const {
    plan_code,
    display_name,
    description,
    price_display,
    storage_gb,
    bandwidth_mbps,
    features = [],
    badge = null,
    is_most_popular = false,
  } = plan;

  // Determine button text and style
  const getButtonConfig = (): {
    text: string;
    className: string;
    disabled: boolean;
  } => {
    if (isCurrent) {
      return {
        text: 'Current Plan',
        className: 'bg-gray-100 text-gray-600 cursor-not-allowed',
        disabled: true,
      };
    }

    const isFree = plan_code.includes('free');
    const planTier = (plan as { tier?: number }).tier ?? 0;
    const isUpgrade = planTier > 0;

    if (isFree) {
      return {
        text: 'Downgrade',
        className: 'bg-white border-2 border-gray-300 text-gray-700 hover:bg-gray-50',
        disabled: false,
      };
    }

    return {
      text: isUpgrade ? 'Upgrade' : 'Select Plan',
      className: 'bg-blue-600 text-white hover:bg-blue-700',
      disabled: false,
    };
  };

  const buttonConfig = getButtonConfig();

  const handleClick = (): void => {
    if (!buttonConfig.disabled && !disabled) {
      onSelect(plan_code);
    }
  };

  return (
    <div
      className={`
        relative rounded-xl p-6 transition-all duration-200
        ${isCurrent
          ? 'border-2 border-blue-500 bg-blue-50 shadow-md'
          : 'border-2 border-gray-200 bg-white hover:shadow-lg hover:border-gray-300'
        }
        ${disabled ? 'opacity-50 pointer-events-none' : ''}
      `}
    >
      {/* Badge */}
      {(badge || is_most_popular) && (
        <div className="absolute -top-3 right-4 bg-orange-500 text-white px-3 py-1 rounded-full text-xs font-semibold shadow-md">
          {badge || 'Most Popular'}
        </div>
      )}

      {/* Current Plan Indicator */}
      {isCurrent && (
        <div className="absolute -top-3 left-4 bg-blue-600 text-white px-3 py-1 rounded-full text-xs font-semibold shadow-md flex items-center gap-1">
          <Crown className="w-3 h-3" />
          <span>Active</span>
        </div>
      )}

      {/* Plan Header */}
      <div className="text-center mb-4">
        <h3 className="text-xl font-bold text-gray-900 mb-1">
          {display_name}
        </h3>
        {description && (
          <p className="text-sm text-gray-600 mb-3">
            {description}
          </p>
        )}
        <div className="text-3xl font-bold text-gray-900">
          {price_display || 'Free'}
        </div>
        {!plan_code.includes('free') && (
          <div className="text-sm text-gray-500 mt-1">
            per month
          </div>
        )}
      </div>

      {/* Specs */}
      <div className="space-y-2 mb-4 pb-4 border-b border-gray-200">
        {/* Storage */}
        <div className="flex items-center gap-2 text-sm text-gray-700">
          <HardDrive className="w-4 h-4 text-blue-600" />
          <span className="font-semibold">{storage_gb} GB</span>
          <span className="text-gray-500">Storage</span>
        </div>

        {/* Bandwidth */}
        <div className="flex items-center gap-2 text-sm text-gray-700">
          <Gauge className="w-4 h-4 text-green-600" />
          <span className="font-semibold">{bandwidth_mbps} Mbps</span>
          <span className="text-gray-500">Bandwidth</span>
        </div>
      </div>

      {/* Features */}
      {features && features.length > 0 && (
        <div className="space-y-2 mb-6">
          {features.map((feature, index) => {
            // Handle both string features and object features
            let featureText: string;
            let isAvailable = true;

            if (typeof feature === 'string') {
              featureText = feature;
            } else if (feature && typeof feature === 'object') {
              // Extract description from feature object (backend sends {name, description, available, tooltip})
              const featureObj = feature as FeatureObject;
              featureText = featureObj.description || featureObj.name || 'Feature';
              isAvailable = featureObj.available !== false;
            } else {
              featureText = 'Feature';
            }

            return (
              <div key={index} className="flex items-start gap-2">
                <Check className={`w-4 h-4 flex-shrink-0 mt-0.5 ${isAvailable ? 'text-green-600' : 'text-gray-400'}`} />
                <span className={`text-sm ${isAvailable ? 'text-gray-700' : 'text-gray-400'}`}>
                  {featureText}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Action Button */}
      <button
        onClick={handleClick}
        disabled={buttonConfig.disabled || disabled}
        className={`
          w-full py-3 px-4 rounded-lg font-semibold
          transition-colors duration-200
          ${buttonConfig.className}
        `}
      >
        {buttonConfig.text}
      </button>
    </div>
  );
}

/**
 * PlanCardSkeleton
 *
 * Loading skeleton for PlanCard
 */
export function PlanCardSkeleton(): ReactElement {
  return (
    <div className="border-2 border-gray-200 rounded-xl p-6 bg-white animate-pulse">
      <div className="text-center mb-4">
        <div className="h-6 bg-gray-200 rounded w-32 mx-auto mb-2"></div>
        <div className="h-4 bg-gray-200 rounded w-24 mx-auto mb-3"></div>
        <div className="h-8 bg-gray-200 rounded w-20 mx-auto"></div>
      </div>

      <div className="space-y-2 mb-4 pb-4 border-b border-gray-200">
        <div className="h-5 bg-gray-200 rounded"></div>
        <div className="h-5 bg-gray-200 rounded"></div>
      </div>

      <div className="space-y-2 mb-6">
        <div className="h-4 bg-gray-200 rounded"></div>
        <div className="h-4 bg-gray-200 rounded"></div>
        <div className="h-4 bg-gray-200 rounded"></div>
      </div>

      <div className="h-12 bg-gray-200 rounded-lg"></div>
    </div>
  );
}
