import { useState, useEffect, useCallback, type ReactElement } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { Cloud, Shield, Sun, Moon } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import { useSubscription } from '../../contexts/SubscriptionContext';
import API_CONFIG from '../../config/api';
import PlanChangeModal from '../subscription/PlanChangeModal';
import PricingCard from './PricingCard';
import type {
  PricingPlan,
  CategorizedPlans,
  BillingCycle,
  ServiceType,
  PlanCategory,
  PlanFeatures,
} from '../../types/pricing.types';
import { isPlansResponse, isCategorizedPlans } from '../../types/pricing.types';
import { cn } from '@/lib/cn';
import { Banner, IconButton, Spinner, Tabs, TabsList, TabsTrigger } from '@/components/ui';

/**
 * Mock plans data for fallback (matches expected_plans_structure.json)
 */
const mockPlansData: {
  edge_plans: CategorizedPlans;
  zk_plans: CategorizedPlans;
} = {
  edge_plans: {
    individual: [
      {
        plan_code: 'normal_free',
        display_name: 'Free Storage',
        description: 'Perfect for getting started',
        price_monthly: null,
        price_six_months: null,
        price_yearly: null,
        storage_gb: 5,
        storage_bytes: 5368709120,
        bandwidth_mbps: 5,
        bandwidth_burst_mbps: 10,
        max_concurrent_streams: 2,
        features: { support: 'community', ai_features: false },
        is_default: true,
        is_active: true,
        is_most_popular: false,
      },
      {
        plan_code: 'normal_basic',
        display_name: 'Basic Storage',
        description: 'Perfect for personal use',
        price_monthly: 99,
        price_six_months: 499,
        price_yearly: 899,
        storage_gb: 200,
        storage_bytes: 214748364800,
        bandwidth_mbps: 25,
        bandwidth_burst_mbps: 50,
        max_concurrent_streams: 5,
        features: { support: 'email', versioning: 10, ai_features: false, video_optimization: 'optimized' as const },
        is_active: true,
        is_default: false,
        is_most_popular: true,
      },
      {
        plan_code: 'normal_pro',
        display_name: 'Pro Storage',
        description: 'For creators and power users',
        price_monthly: 199,
        price_six_months: 999,
        price_yearly: 1799,
        storage_gb: 1024,
        storage_bytes: 1099511627776,
        bandwidth_mbps: 100,
        bandwidth_burst_mbps: 200,
        max_concurrent_streams: 10,
        features: { support: 'priority', versioning: 50, ai_features: true, video_optimization: 'optimized' as const },
        is_active: true,
        is_default: false,
        is_most_popular: false,
      },
      {
        plan_code: 'normal_pro_plus',
        display_name: 'Pro Plus Storage',
        description: 'For power users needing more',
        price_monthly: 299,
        price_six_months: 1499,
        price_yearly: 2499,
        storage_gb: 2048,
        storage_bytes: 2199023255552,
        bandwidth_mbps: 150,
        bandwidth_burst_mbps: 300,
        max_concurrent_streams: 15,
        features: { support: 'priority', versioning: 100, ai_features: true, video_optimization: 'keep_both' as const },
        is_active: true,
        is_default: false,
        is_most_popular: false,
      },
      {
        plan_code: 'normal_pro_ultra',
        display_name: 'Pro Ultra Storage',
        description: 'High-capacity for heavy creators',
        price_monthly: 399,
        price_six_months: 1999,
        price_yearly: 3499,
        storage_gb: 3072,
        storage_bytes: 3298534883328,
        bandwidth_mbps: 200,
        bandwidth_burst_mbps: 400,
        max_concurrent_streams: 20,
        features: { support: 'priority', versioning: 150, ai_features: true, video_optimization: 'keep_both' as const },
        is_active: true,
        is_default: false,
        is_most_popular: false,
      },
      {
        plan_code: 'normal_solo_max',
        display_name: 'Solo Max Storage',
        description: 'Massive personal storage',
        price_monthly: 599,
        price_six_months: 2999,
        price_yearly: 5499,
        storage_gb: 5120,
        storage_bytes: 5497558138880,
        bandwidth_mbps: 300,
        bandwidth_burst_mbps: 600,
        max_concurrent_streams: 25,
        features: { support: 'priority', versioning: 200, ai_features: true, team_sharing: false, video_optimization: 'keep_both' as const },
        is_active: true,
        is_default: false,
        is_most_popular: false,
      },
    ],
    business: [
      {
        plan_code: 'normal_team',
        display_name: 'Team Storage',
        description: 'Collaboration-ready storage for teams',
        price_monthly: 799,
        price_six_months: 3999,
        price_yearly: 6999,
        storage_gb: 5120,
        storage_bytes: 5497558138880,
        bandwidth_mbps: 500,
        bandwidth_burst_mbps: 1000,
        max_concurrent_streams: 25,
        features: { support: '24/7', versioning: 100, ai_features: true, team_sharing: true, video_optimization: 'keep_both' as const },
        is_active: true,
        is_default: false,
        is_most_popular: true,
      },
    ],
    enterprise: [],
  },
  zk_plans: {
    individual: [
      {
        plan_code: 'zk_pro',
        display_name: 'ZK Pro',
        description: '1TB zero-knowledge encrypted vault',
        price_monthly: 399,
        price_six_months: 1999,
        price_yearly: 3499,
        storage_gb: 1024,
        storage_bytes: 1099511627776,
        bandwidth_mbps: 20,
        bandwidth_burst_mbps: 40,
        max_concurrent_streams: 5,
        features: {
          support: 'priority',
          webauthn: true,
          encryption: 'zero_knowledge',
          versioning: true,
          hardware_keys: 10,
          recovery_phrase: true,
        },
        is_active: true,
        is_default: false,
        is_most_popular: true,
      },
      {
        plan_code: 'zk_pro_plus',
        display_name: 'ZK Pro Plus',
        description: '2TB zero-knowledge encrypted storage',
        price_monthly: 699,
        price_six_months: 3499,
        price_yearly: 5999,
        storage_gb: 2048,
        storage_bytes: 2199023255552,
        bandwidth_mbps: 30,
        bandwidth_burst_mbps: 60,
        max_concurrent_streams: 7,
        features: {
          support: 'priority',
          webauthn: true,
          encryption: 'zero_knowledge',
          versioning: true,
          hardware_keys: 15,
          recovery_phrase: true,
        },
        is_active: true,
        is_default: false,
        is_most_popular: false,
      },
      {
        plan_code: 'zk_ultra',
        display_name: 'ZK Ultra',
        description: '3TB zero-knowledge encrypted vault',
        price_monthly: 999,
        price_six_months: 4999,
        price_yearly: 8999,
        storage_gb: 3072,
        storage_bytes: 3298534883328,
        bandwidth_mbps: 40,
        bandwidth_burst_mbps: 80,
        max_concurrent_streams: 10,
        features: {
          support: 'priority',
          webauthn: true,
          encryption: 'zero_knowledge',
          versioning: true,
          hardware_keys: 25,
          recovery_phrase: true,
        },
        is_active: true,
        is_default: false,
        is_most_popular: false,
      },
      {
        plan_code: 'zk_max',
        display_name: 'ZK Max',
        description: '5TB zero-knowledge encrypted personal vault',
        price_monthly: 1399,
        price_six_months: 6999,
        price_yearly: 11999,
        storage_gb: 5120,
        storage_bytes: 5497558138880,
        bandwidth_mbps: 60,
        bandwidth_burst_mbps: 120,
        max_concurrent_streams: 15,
        features: {
          support: 'priority',
          webauthn: true,
          encryption: 'zero_knowledge',
          versioning: true,
          hardware_keys: 40,
          recovery_phrase: true,
        },
        is_active: true,
        is_default: false,
        is_most_popular: false,
      },
    ],
    business: [],
    enterprise: [],
  },
};

const categoryLabels: Record<PlanCategory, string> = {
  individual: 'Individual',
  business: 'Business',
  enterprise: 'Enterprise',
};

const categories: PlanCategory[] = ['individual', 'business', 'enterprise'];

/**
 * PricingPage — public-facing plan catalog split into Edge Storage and
 * Zero-Knowledge sections with category tabs (Individual / Business /
 * Enterprise). Rebuilt on Signal primitives: Tabs for category switching,
 * PricingCard for each plan, Banner for errors. Theme handled via CSS vars
 * — `darkMode ? ... : ...` ternaries replaced with `text-fg`, `bg-surface`,
 * etc. tokens.
 *
 * Business logic preserved: plan fetching from two endpoints (edge + zk),
 * fallback to mock data, PlanChangeModal opening for logged-in users,
 * redirect to /auth for guests, and the ?upgrade=<plan_code> deep link
 * that auto-opens the modal after registration.
 */
export default function PricingPage(): ReactElement {
  const navigate = useNavigate();
  const { darkMode, toggleTheme } = useTheme();
  const { isAuthenticated, user, zkEnabled } = useAuth();
  const { availablePlans } = useSubscription();

  const showEdgePlans = !isAuthenticated || !zkEnabled;
  const showZkPlans = !isAuthenticated || zkEnabled;

  const [edgeCategory, setEdgeCategory] = useState<PlanCategory>('individual');
  const [zkCategory, setZkCategory] = useState<PlanCategory>('individual');

  const [edgePlans, setEdgePlans] = useState<CategorizedPlans>({
    individual: [],
    business: [],
    enterprise: [],
  });
  const [zkPlans, setZkPlans] = useState<CategorizedPlans>({
    individual: [],
    business: [],
    enterprise: [],
  });
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedPlan, setSelectedPlan] = useState<PricingPlan | null>(null);
  const [modalOpen, setModalOpen] = useState<boolean>(false);
  const [upgradeBillingCycle, setUpgradeBillingCycle] = useState<BillingCycle | undefined>();

  useEffect(() => {
    const fetchPlans = async (): Promise<void> => {
      setLoading(true);
      setError(null);

      try {
        const edgeResponse = await fetch(
          `${API_CONFIG.STORAGE_API}/api/v1/auth/plans?service_type=normal`,
          { credentials: 'include' }
        );
        if (!edgeResponse.ok) {
          throw new Error(`Failed to fetch edge plans: ${edgeResponse.status}`);
        }
        const edgeData: unknown = await edgeResponse.json();
        if (isPlansResponse(edgeData)) setEdgePlans(edgeData.plans);
        else if (isCategorizedPlans(edgeData)) setEdgePlans(edgeData);
        else setEdgePlans(mockPlansData.edge_plans);

        const zkResponse = await fetch(
          `${API_CONFIG.STORAGE_API}/api/v1/auth/plans?service_type=zk`,
          { credentials: 'include' }
        );
        if (!zkResponse.ok) {
          throw new Error(`Failed to fetch ZK plans: ${zkResponse.status}`);
        }
        const zkData: unknown = await zkResponse.json();
        if (isPlansResponse(zkData)) setZkPlans(zkData.plans);
        else if (isCategorizedPlans(zkData)) setZkPlans(zkData);
        else setZkPlans(mockPlansData.zk_plans);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('Failed to fetch plans:', error);
        setError('Failed to load pricing plans. Please try again later.');

        if (process.env.NODE_ENV !== 'production') {
          setEdgePlans(mockPlansData.edge_plans);
          setZkPlans(mockPlansData.zk_plans);
        }
      } finally {
        setLoading(false);
      }
    };

    void fetchPlans();
  }, []);

  const handlePlanSelect = useCallback(
    (planCode: string, serviceType: ServiceType, billingCycle: BillingCycle): void => {
      if (!isAuthenticated || !user) {
        navigate(`/auth?plan=${planCode}&service=${serviceType}&billing=${billingCycle}`);
        return;
      }

      const allEdge = [
        ...(edgePlans?.individual || []),
        ...(edgePlans?.business || []),
        ...(edgePlans?.enterprise || []),
      ];
      const allZk = [
        ...(zkPlans?.individual || []),
        ...(zkPlans?.business || []),
        ...(zkPlans?.enterprise || []),
      ];
      const allFetched = [...allEdge, ...allZk];

      let foundPlan: PricingPlan | undefined = allFetched.find(
        (p) => p.plan_code === planCode
      );

      if (!foundPlan) {
        const dashPlan = availablePlans.find((p) => {
          const pc = p as { planCode?: string; plan_code?: string };
          return pc.plan_code === planCode || pc.planCode === planCode;
        });

        if (dashPlan) {
          const d = dashPlan as Record<string, unknown>;
          const base: PricingPlan = {
            plan_code: (d.plan_code || d.planCode || planCode) as string,
            display_name: (d.display_name || d.displayName || planCode) as string,
            description: (d.description || '') as string,
            price_monthly: (d.price_monthly ?? d.priceMonthly ?? null) as number | null,
            price_six_months: (d.price_six_months ?? null) as number | null,
            price_yearly: (d.price_yearly ?? d.priceYearly ?? null) as number | null,
            storage_gb: (d.storage_gb ?? d.storageGb ?? 0) as number,
            bandwidth_mbps: (d.bandwidth_mbps ?? d.bandwidthMbps ?? 0) as number,
            max_concurrent_streams: (d.max_concurrent_streams ?? d.max_streams ?? 5) as number,
            features: (d.features || {}) as PlanFeatures,
            is_most_popular: (d.is_most_popular ?? false) as boolean,
          };
          if (typeof d.storage_bytes === 'number') base.storage_bytes = d.storage_bytes;
          if (typeof d.bandwidth_burst_mbps === 'number')
            base.bandwidth_burst_mbps = d.bandwidth_burst_mbps;
          foundPlan = base;
        }
      }

      if (foundPlan) {
        setSelectedPlan(foundPlan);
        setModalOpen(true);
      } else {
        console.error('Plan not found:', planCode);
        navigate('/');
      }
    },
    [isAuthenticated, user, availablePlans, edgePlans, zkPlans, navigate]
  );

  const handleCloseModal = useCallback((): void => {
    setModalOpen(false);
    setSelectedPlan(null);
    setUpgradeBillingCycle(undefined);
  }, []);

  // Auto-open PlanChangeModal when redirected from registration with a pending upgrade
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const upgradePlan = params.get('upgrade');

    if (upgradePlan && user && !loading) {
      const allPlans = [...edgePlans.individual, ...edgePlans.business];
      const targetPlan = allPlans.find((p) => p.plan_code === upgradePlan);
      if (targetPlan) {
        const billingParam = params.get('billing') as BillingCycle | null;
        setSelectedPlan(targetPlan);
        setUpgradeBillingCycle(billingParam || undefined);
        setModalOpen(true);
        window.history.replaceState({}, '', '/pricing');
      }
    }
  }, [edgePlans, user, loading]);

  return (
    <div className="min-h-screen bg-bg">
      {/* Top nav */}
      <nav className="fixed inset-x-0 top-0 z-50 border-b border-border bg-surface/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <button
            type="button"
            onClick={() => navigate('/auth')}
            className="flex items-center gap-3 focus-visible:outline-none"
          >
            <div className="relative">
              <div className="absolute inset-0 rounded-xl bg-gradient-to-br from-primary to-accent opacity-40 blur-lg" />
              <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-accent shadow-lg">
                <Cloud className="h-5 w-5 text-white" />
              </div>
            </div>
            <span className="text-body font-semibold tracking-tight text-fg">
              Edge Cloud Storage
            </span>
          </button>

          <div className="flex items-center gap-4">
            <Link
              to="#"
              className="text-body-sm font-medium text-fg-muted transition-colors hover:text-fg"
            >
              About
            </Link>
            <Link
              to="#"
              className="text-body-sm font-medium text-fg-muted transition-colors hover:text-fg"
            >
              Products
            </Link>
            <Link
              to="/pricing"
              className="text-body-sm font-medium text-primary transition-colors hover:text-primary-hover"
            >
              Pricing
            </Link>
            <IconButton
              variant="ghost"
              size="md"
              onClick={toggleTheme}
              aria-label="Toggle theme"
            >
              {darkMode ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </IconButton>
          </div>
        </div>
      </nav>

      <main className="px-6 pb-20 pt-32">
        <div className="mx-auto max-w-7xl">
          {error && (
            <Banner variant="danger" title="Pricing unavailable" className="mb-8">
              {error}
            </Banner>
          )}

          {/* Hero */}
          <div className="mb-16 text-center">
            <h1 className="mb-4 text-5xl md:text-6xl font-bold tracking-tight text-fg">
              Simple, transparent{' '}
              <span className="bg-gradient-to-r from-primary via-accent to-info bg-clip-text text-transparent">
                pricing
              </span>
            </h1>
            <p className="mx-auto max-w-2xl text-xl md:text-2xl text-fg-muted">
              Choose the perfect plan for your needs. All plans include our core features.
            </p>
          </div>

          {/* Edge Storage Section */}
          {showEdgePlans && (
            <section className="mb-20">
              <div className="mb-8 flex items-center gap-3">
                <div
                  aria-hidden
                  className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10 text-primary"
                >
                  <Cloud className="h-6 w-6" />
                </div>
                <div>
                  <h2 className="text-h2 font-bold text-fg">Edge Storage</h2>
                  <p className="text-body-sm text-fg-muted">
                    High-performance cloud storage with AI-powered features
                  </p>
                </div>
              </div>

              <div className="mb-8">
                <Tabs value={edgeCategory} onChange={(v) => setEdgeCategory(v as PlanCategory)} variant="pill">
                  <TabsList>
                    {categories.map((cat) => (
                      <TabsTrigger key={cat} value={cat}>
                        {categoryLabels[cat]}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </div>

              <PlansGrid
                plans={edgePlans[edgeCategory]}
                serviceType="edge"
                loading={loading}
                emptyLabel={`${categoryLabels[edgeCategory]} plans coming soon`}
                onSelect={handlePlanSelect}
              />
            </section>
          )}

          {/* ZK Encryption Section */}
          {showZkPlans && (
            <section>
              <div className="mb-8 flex items-center gap-3">
                <div
                  aria-hidden
                  className="flex h-12 w-12 items-center justify-center rounded-xl bg-accent/10 text-accent"
                >
                  <Shield className="h-6 w-6" />
                </div>
                <div>
                  <h2 className="text-h2 font-bold text-fg">Zero-Knowledge Encryption</h2>
                  <p className="text-body-sm text-fg-muted">
                    Client-side encryption where you control the keys
                  </p>
                </div>
              </div>

              <div className="mb-8">
                <Tabs value={zkCategory} onChange={(v) => setZkCategory(v as PlanCategory)} variant="pill">
                  <TabsList>
                    {categories.map((cat) => (
                      <TabsTrigger key={cat} value={cat}>
                        {categoryLabels[cat]}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                </Tabs>
              </div>

              <PlansGrid
                plans={zkPlans[zkCategory]}
                serviceType="zk"
                loading={loading}
                emptyLabel={`${categoryLabels[zkCategory]} plans coming soon`}
                onSelect={handlePlanSelect}
              />
            </section>
          )}
        </div>
      </main>

      {/* Plan Change Modal */}
      {selectedPlan && (
        <PlanChangeModal
          isOpen={modalOpen}
          onClose={handleCloseModal}
          targetPlan={selectedPlan}
          {...(upgradeBillingCycle != null && { initialBillingCycle: upgradeBillingCycle })}
        />
      )}
    </div>
  );
}

function PlansGrid({
  plans,
  serviceType,
  loading,
  emptyLabel,
  onSelect,
}: {
  plans: PricingPlan[] | undefined;
  serviceType: ServiceType;
  loading: boolean;
  emptyLabel: string;
  onSelect: (planCode: string, serviceType: ServiceType, billingCycle: BillingCycle) => void;
}): ReactElement {
  if (loading) {
    return (
      <div className="flex flex-col items-center py-12">
        <Spinner size="lg" />
        <p className="mt-4 text-body-sm text-fg-muted">Loading plans...</p>
      </div>
    );
  }

  if (!plans || plans.length === 0) {
    return (
      <div
        className={cn(
          'rounded-2xl border border-border bg-surface-muted px-6 py-12 text-center'
        )}
      >
        <p className="text-body-sm text-fg-muted">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {plans.map((plan) => (
        <PricingCard
          key={plan.plan_code}
          plan={plan}
          serviceType={serviceType}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
