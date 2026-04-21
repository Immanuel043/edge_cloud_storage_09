import React, { useState, useEffect } from 'react';
import { Crown, X, ArrowRight, TrendingUp, Shield, Lock, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useSubscription } from '../../contexts/SubscriptionContext';
import { useAuth } from '../../contexts/AuthContext';
import type { FreeAccountUpgradeBannerProps } from './types';
import { Badge, Button, IconButton } from '@/components/ui';

/**
 * FreeAccountUpgradeBanner — upgrade nudge for free-tier users. Renders two
 * variants:
 *   - ZK users get the premium security-focused hero with gradient trim.
 *   - Edge users get a compact upgrade card.
 * Both dismiss permanently via localStorage.
 */
const FreeAccountUpgradeBanner: React.FC<FreeAccountUpgradeBannerProps> = () => {
  const navigate = useNavigate();
  const { subscription, loading } = useSubscription();
  const { zkEnabled } = useAuth();
  const [isVisible, setIsVisible] = useState<boolean>(false);

  useEffect(() => {
    if (loading) return;

    const subRecord = subscription as Record<string, unknown> | null;
    const plan = subRecord?.plan as Record<string, unknown> | undefined;

    const isFree =
      plan?.tier_name === 'free' ||
      (typeof plan?.plan_code === 'string' && plan.plan_code.includes('free')) ||
      subRecord?.tier_name === 'free' ||
      (typeof subRecord?.plan_code === 'string' && subRecord.plan_code.includes('free'));

    const isDismissed = localStorage.getItem('free_upgrade_banner_dismissed') === 'true';
    if (isFree && !isDismissed) {
      setIsVisible(true);
    }
  }, [subscription, loading]);

  const handleDismiss = (): void => {
    localStorage.setItem('free_upgrade_banner_dismissed', 'true');
    setIsVisible(false);
  };

  const handleUpgrade = (): void => {
    navigate('/pricing');
  };

  if (loading || !isVisible) {
    return null;
  }

  // ZK Premium hero — gradient trim preserved, tokens swapped
  if (zkEnabled) {
    return (
      <div className="relative mb-4 overflow-hidden rounded-xl bg-gradient-to-br from-primary via-accent to-danger p-0.5 shadow-lg">
        <div className="relative rounded-[10px] bg-surface-elevated p-5">
          <div className="absolute right-20 top-2 opacity-20">
            <Sparkles className="h-6 w-6 text-accent" />
          </div>

          <div className="flex items-start gap-4">
            <div className="relative flex-shrink-0">
              <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-accent to-danger opacity-50 blur-md" />
              <div className="relative flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-accent to-danger text-white">
                <Shield className="h-6 w-6" />
              </div>
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="mb-2 flex items-center gap-2">
                    <h3 className="text-h3 font-bold text-fg">
                      Unlock zero-knowledge premium
                    </h3>
                    <Badge variant="warning" size="sm">
                      Exclusive
                    </Badge>
                  </div>

                  <p className="mb-4 text-body-sm text-fg-muted">
                    Enterprise-grade encryption with military-level security. Your data,
                    absolutely unreadable by anyone but you.
                  </p>

                  <div className="space-y-2.5 text-body-sm text-fg">
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg bg-accent/15 p-1.5">
                        <Lock className="h-3.5 w-3.5 text-accent" />
                      </div>
                      <span className="font-medium">
                        Up to 1TB zero-knowledge encrypted storage
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg bg-primary/15 p-1.5">
                        <Shield className="h-3.5 w-3.5 text-primary" />
                      </div>
                      <span className="font-medium">
                        Military-grade E2E encryption (AES-256-GCM)
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="rounded-lg bg-danger/15 p-1.5">
                        <Sparkles className="h-3.5 w-3.5 text-danger" />
                      </div>
                      <span className="font-medium">
                        Priority support &amp; advanced security features
                      </span>
                    </div>
                  </div>

                  <div className="mt-4 inline-flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-1">
                    <span className="text-caption text-fg-muted">Starting at</span>
                    <span className="bg-gradient-to-r from-accent to-danger bg-clip-text text-body-lg font-bold text-transparent">
                      ₹1,499/year
                    </span>
                  </div>

                  <div className="mt-5">
                    <Button
                      variant="primary"
                      size="md"
                      onClick={handleUpgrade}
                      leftIcon={<Shield className="h-4 w-4" />}
                      rightIcon={<ArrowRight className="h-4 w-4" />}
                    >
                      Upgrade to premium
                    </Button>
                  </div>
                </div>

                <IconButton
                  variant="ghost"
                  size="sm"
                  onClick={handleDismiss}
                  aria-label="Dismiss permanently"
                  className="mt-1 flex-shrink-0"
                >
                  <X className="h-4 w-4" />
                </IconButton>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Edge (normal storage) compact upgrade card
  return (
    <div className="mb-4 rounded-lg border border-accent/30 bg-gradient-to-r from-accent/10 to-primary/10 p-4">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 rounded-lg bg-accent/15 p-2 text-accent">
          <Crown className="h-5 w-5" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <h3 className="flex items-center gap-2 font-semibold text-fg">
                <TrendingUp className="h-4 w-4" />
                Upgrade your storage
              </h3>
              <p className="mt-1 text-body-sm text-fg-muted">
                Unlock more storage, faster speeds, and premium features with our paid plans.
              </p>

              <div className="mt-3 space-y-1 text-body-sm text-fg">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-1.5 rounded-full bg-accent" />
                  <span>Up to 5TB of storage</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-1.5 rounded-full bg-accent" />
                  <span>Priority support &amp; AI features</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="h-1.5 w-1.5 rounded-full bg-accent" />
                  <span>Starting at just ₹899/year</span>
                </div>
              </div>

              <div className="mt-4">
                <Button
                  variant="primary"
                  size="sm"
                  onClick={handleUpgrade}
                  rightIcon={<ArrowRight className="h-4 w-4" />}
                >
                  View plans
                </Button>
              </div>
            </div>

            <IconButton
              variant="ghost"
              size="sm"
              onClick={handleDismiss}
              aria-label="Dismiss permanently"
            >
              <X className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
      </div>
    </div>
  );
};

export default FreeAccountUpgradeBanner;
