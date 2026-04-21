import { type ReactElement } from 'react';
import { Check, Crown, HardDrive, Gauge } from 'lucide-react';
import type { PlanCardProps, FeatureObject } from '../../types/subscription-components.types';
import { Badge, Button, Card, CardContent, Skeleton } from '@/components/ui';
import { cn } from '@/lib/cn';

/**
 * PlanCard — displays a subscription plan: header, price, storage/bandwidth
 * specs, feature checklist, and a CTA that changes based on whether this is
 * the user's current plan, a free downgrade, or an upgrade.
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
    features: rawFeatures,
    badge = null,
    is_most_popular = false,
  } = plan;

  const features: (string | FeatureObject)[] = Array.isArray(rawFeatures) ? rawFeatures : [];

  const getButtonConfig = (): {
    text: string;
    variant: 'primary' | 'secondary' | 'ghost';
    disabled: boolean;
  } => {
    if (isCurrent) {
      return { text: 'Current plan', variant: 'ghost', disabled: true };
    }

    const isFree = plan_code.includes('free');
    const planTier = (plan as { tier?: number }).tier ?? 0;
    const isUpgrade = planTier > 0;

    if (isFree) {
      return { text: 'Downgrade', variant: 'secondary', disabled: false };
    }

    return { text: isUpgrade ? 'Upgrade' : 'Select plan', variant: 'primary', disabled: false };
  };

  const buttonConfig = getButtonConfig();

  const handleClick = (): void => {
    if (!buttonConfig.disabled && !disabled) {
      onSelect(plan_code);
    }
  };

  return (
    <Card
      variant={isCurrent ? 'elevated' : 'bordered'}
      className={cn(
        'relative transition-all duration-normal',
        isCurrent
          ? 'border-2 border-primary bg-primary/5'
          : 'border-2 hover:border-border-strong hover:shadow-md',
        disabled && 'pointer-events-none opacity-50'
      )}
    >
      {(badge || is_most_popular) && (
        <div className="absolute -top-3 right-4">
          <Badge variant="warning" size="md">
            {badge || 'Most popular'}
          </Badge>
        </div>
      )}

      {isCurrent && (
        <div className="absolute -top-3 left-4">
          <Badge variant="info" size="md">
            <Crown className="h-3 w-3" />
            Active
          </Badge>
        </div>
      )}

      <CardContent className="p-6">
        <div className="mb-4 text-center">
          <h3 className="mb-1 text-h3 font-bold text-fg">{display_name}</h3>
          {description && <p className="mb-3 text-body-sm text-fg-muted">{description}</p>}
          <div className="text-h1 font-bold text-fg">{price_display || 'Free'}</div>
          {!plan_code.includes('free') && (
            <div className="mt-1 text-body-sm text-fg-muted">per month</div>
          )}
        </div>

        <div className="mb-4 space-y-2 border-b border-border pb-4">
          <div className="flex items-center gap-2 text-body-sm text-fg">
            <HardDrive className="h-4 w-4 text-primary" />
            <span className="font-semibold">{storage_gb} GB</span>
            <span className="text-fg-muted">Storage</span>
          </div>

          <div className="flex items-center gap-2 text-body-sm text-fg">
            <Gauge className="h-4 w-4 text-success" />
            <span className="font-semibold">{bandwidth_mbps} Mbps</span>
            <span className="text-fg-muted">Bandwidth</span>
          </div>
        </div>

        {features && features.length > 0 && (
          <div className="mb-6 space-y-2">
            {features.map((feature, index) => {
              let featureText: string;
              let isAvailable = true;

              if (typeof feature === 'string') {
                featureText = feature;
              } else if (feature && typeof feature === 'object') {
                const featureObj = feature as FeatureObject;
                featureText = featureObj.description || featureObj.name || 'Feature';
                isAvailable = featureObj.available !== false;
              } else {
                featureText = 'Feature';
              }

              return (
                <div key={index} className="flex items-start gap-2">
                  <Check
                    className={cn(
                      'mt-0.5 h-4 w-4 shrink-0',
                      isAvailable ? 'text-success' : 'text-fg-subtle'
                    )}
                  />
                  <span
                    className={cn(
                      'text-body-sm',
                      isAvailable ? 'text-fg' : 'text-fg-subtle'
                    )}
                  >
                    {featureText}
                  </span>
                </div>
              );
            })}
          </div>
        )}

        <Button
          variant={buttonConfig.variant}
          fullWidth
          onClick={handleClick}
          disabled={buttonConfig.disabled || disabled}
        >
          {buttonConfig.text}
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * PlanCardSkeleton — loading placeholder.
 */
export function PlanCardSkeleton(): ReactElement {
  return (
    <Card variant="bordered" className="p-6">
      <div className="mb-4 space-y-2 text-center">
        <Skeleton className="mx-auto h-6 w-32" />
        <Skeleton className="mx-auto h-4 w-24" />
        <Skeleton className="mx-auto h-8 w-20" />
      </div>

      <div className="mb-4 space-y-2 border-b border-border pb-4">
        <Skeleton className="h-5 w-full" />
        <Skeleton className="h-5 w-full" />
      </div>

      <div className="mb-6 space-y-2">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
      </div>

      <Skeleton className="h-12 w-full" />
    </Card>
  );
}
