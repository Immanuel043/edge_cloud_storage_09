import { useCallback, useState, type ReactElement } from 'react';
import { ArrowRight, Check, Crown, Gauge, HardDrive, Zap } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Badge, Button, Card, CardContent } from '@/components/ui';
import type {
  BillingCycle,
  PricingPlan,
  ServiceType,
} from '../../types/pricing.types';
import BillingCycleToggle from './BillingCycleToggle';

/**
 * PricingCard — one plan tile on the pricing page. Shows price (with
 * billing-cycle toggle), core quotas, a feature list, and a CTA. Highlights
 * the "most popular" plan via primary-ring border. Presentation-only;
 * selection is delegated to the parent through `onSelect`.
 */

export interface PricingCardProps {
  plan: PricingPlan;
  serviceType: ServiceType;
  onSelect: (planCode: string, serviceType: ServiceType, billingCycle: BillingCycle) => void;
}

export function PricingCard({
  plan,
  serviceType,
  onSelect,
}: PricingCardProps): ReactElement {
  const hasMonthly = plan.price_monthly !== null;
  const hasSixMonths = plan.price_six_months !== null;
  const hasYearly = plan.price_yearly !== null;
  const isFree = !hasMonthly && !hasSixMonths && !hasYearly;

  const getDefaultCycle = useCallback((): BillingCycle => {
    if (hasMonthly) return 'monthly';
    if (hasSixMonths) return 'six_months';
    if (hasYearly) return 'yearly';
    return 'monthly';
  }, [hasMonthly, hasSixMonths, hasYearly]);

  const [billingCycle, setBillingCycle] = useState<BillingCycle>(getDefaultCycle());

  const formatPrice = (p: number): string =>
    Number.isInteger(p) ? `₹${p}` : `₹${p.toFixed(2)}`;

  const getPrice = (): string => {
    if (isFree) return 'Free';

    // yearly-only plans
    if (!hasMonthly && !hasSixMonths && hasYearly) {
      return formatPrice(plan.price_yearly ?? 0);
    }

    switch (billingCycle) {
      case 'monthly':
        return hasMonthly
          ? formatPrice(plan.price_monthly ?? 0)
          : formatPrice(plan.price_yearly ?? 0);
      case 'six_months':
        return hasSixMonths
          ? formatPrice(plan.price_six_months ?? 0)
          : formatPrice(plan.price_yearly ?? 0);
      case 'yearly':
        return hasYearly
          ? formatPrice(plan.price_yearly ?? 0)
          : formatPrice(plan.price_monthly ?? 0);
      default:
        return formatPrice(plan.price_monthly ?? plan.price_yearly ?? 0);
    }
  };

  const getFeaturesList = (): string[] => {
    const features: string[] = [];
    const f = plan.features;

    if (f.support) {
      const supportText = f.support === '24/7' ? '24/7' : f.support;
      features.push(`${supportText.charAt(0).toUpperCase() + supportText.slice(1)} support`);
    }
    if (f.versioning !== undefined) {
      if (typeof f.versioning === 'number') features.push(`${f.versioning} file versions`);
      else if (f.versioning === 'unlimited') features.push('Unlimited file versions');
      else if (f.versioning === true) features.push('File versioning');
    }
    if (f.ai_features) features.push('AI features');
    if (f.team_sharing) features.push('Team sharing');
    if (f.webauthn) features.push('WebAuthn authentication');
    if (f.hardware_keys !== undefined) features.push(`${f.hardware_keys} hardware keys`);
    if (f.recovery_phrase) features.push('Recovery phrase');
    if (f.encryption === 'zero_knowledge') features.push('Zero-knowledge encryption');
    if (f.video_optimization === 'optimized') features.push('Video optimization');
    else if (f.video_optimization === 'keep_both') {
      features.push('Video optimization');
      features.push('Keep both video versions');
    }

    return features;
  };

  const handleSelect = (): void => {
    onSelect(plan.plan_code, serviceType, billingCycle);
  };

  const savingsLabel = (() => {
    if (!hasMonthly || !plan.price_monthly || billingCycle === 'monthly') return null;
    const months = billingCycle === 'six_months' ? 6 : 12;
    const cyclePrice =
      billingCycle === 'six_months' ? plan.price_six_months : plan.price_yearly;
    if (!cyclePrice) return null;
    const savings = Math.round((1 - cyclePrice / (plan.price_monthly * months)) * 100);
    return savings > 0 ? `Save ${savings}%` : null;
  })();

  const cycleLabel =
    billingCycle === 'monthly'
      ? 'per month'
      : billingCycle === 'six_months'
        ? 'per 6 months'
        : 'per year';

  return (
    <Card
      variant="bordered"
      className={cn(
        'relative transition-colors duration-base hover:border-border-strong',
        plan.is_most_popular && 'ring-2 ring-primary/40'
      )}
    >
      {/* Corner badges */}
      {plan.is_most_popular && (
        <div className="absolute -top-3 right-4">
          <Badge variant="info" size="sm">Most popular</Badge>
        </div>
      )}
      {plan.is_default && (
        <div className="absolute -top-3 left-4">
          <Badge variant="success" size="sm">
            <Crown className="h-3 w-3" />
            Free
          </Badge>
        </div>
      )}

      <CardContent className="p-6">
        <div className="mb-4">
          <h3 className="text-h3 font-semibold text-fg">{plan.display_name}</h3>
          <p className="mt-1 text-body-sm text-fg-muted">{plan.description}</p>
        </div>

        <div className="mb-5">
          <div className="mb-2 text-4xl font-bold text-fg">{getPrice()}</div>

          {hasMonthly && (
            <div className="space-y-2">
              <BillingCycleToggle
                value={billingCycle}
                onChange={setBillingCycle}
                hasMonthly={hasMonthly}
                hasSixMonths={hasSixMonths}
                hasYearly={hasYearly}
              />
              <div className="text-caption text-fg-muted">
                {cycleLabel}
                {savingsLabel && <span className="ml-2 text-success">· {savingsLabel}</span>}
              </div>
            </div>
          )}

          {!hasMonthly && !hasSixMonths && hasYearly && (
            <div className="text-caption font-medium text-primary">Billed yearly</div>
          )}
        </div>

        <div className="mb-4 space-y-2 border-b border-border pb-4">
          <QuotaRow
            icon={<HardDrive className="h-4 w-4 text-primary" />}
            value={
              plan.storage_gb >= 1024
                ? `${(plan.storage_gb / 1024).toFixed(0)} TB`
                : `${plan.storage_gb} GB`
            }
            label="Storage"
          />
          <QuotaRow
            icon={<Gauge className="h-4 w-4 text-success" />}
            value={`${plan.bandwidth_mbps} Mbps`}
            label="Bandwidth"
          />
          <QuotaRow
            icon={<Zap className="h-4 w-4 text-warning" />}
            value={`${plan.max_concurrent_streams}`}
            label="Concurrent streams"
          />
        </div>

        <ul className="mb-6 space-y-2">
          {getFeaturesList().map((feature, index) => (
            <li key={index} className="flex items-start gap-2">
              <Check className="mt-0.5 h-4 w-4 flex-shrink-0 text-success" />
              <span className="text-body-sm text-fg">{feature}</span>
            </li>
          ))}
        </ul>

        <Button
          variant="primary"
          size="lg"
          fullWidth
          onClick={handleSelect}
          rightIcon={<ArrowRight className="h-4 w-4" />}
        >
          Get started
        </Button>
      </CardContent>
    </Card>
  );
}

function QuotaRow({
  icon,
  value,
  label,
}: {
  icon: ReactElement;
  value: string;
  label: string;
}): ReactElement {
  return (
    <div className="flex items-center gap-2 text-body-sm text-fg">
      {icon}
      <span className="font-semibold">{value}</span>
      <span className="text-fg-muted">{label}</span>
    </div>
  );
}

export default PricingCard;
