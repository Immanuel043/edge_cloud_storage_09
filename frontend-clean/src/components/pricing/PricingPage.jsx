import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import {
  Cloud, Shield, Check, ArrowRight, Sun, Moon,
  HardDrive, Gauge, Users, Crown, Zap, Lock
} from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';

// Mock data structure matching the categorized plan format
const mockPlansData = {
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
        bandwidth_mbps: 5,
        bandwidth_burst_mbps: 10,
        max_concurrent_streams: 2,
        features: { support: 'community', ai_features: false },
        is_default: true
      },
      {
        plan_code: 'normal_basic',
        display_name: 'Basic Storage',
        description: 'Perfect for personal use',
        price_monthly: 99,
        price_six_months: 499,
        price_yearly: 899,
        storage_gb: 200,
        bandwidth_mbps: 25,
        bandwidth_burst_mbps: 50,
        max_concurrent_streams: 5,
        features: { support: 'email', versioning: 10, ai_features: false }
      },
      {
        plan_code: 'normal_pro',
        display_name: 'Pro Storage',
        description: 'For creators and power users',
        price_monthly: 199,
        price_six_months: 799,
        price_yearly: 1299,
        storage_gb: 1024,
        bandwidth_mbps: 100,
        bandwidth_burst_mbps: 200,
        max_concurrent_streams: 10,
        features: { support: 'priority', versioning: 50, ai_features: true },
        is_most_popular: true
      },
      {
        plan_code: 'normal_pro_plus',
        display_name: 'Pro Plus Storage',
        description: 'For power users needing more',
        price_monthly: 299,
        price_six_months: 1299,
        price_yearly: 2299,
        storage_gb: 2048,
        bandwidth_mbps: 150,
        bandwidth_burst_mbps: 300,
        max_concurrent_streams: 15,
        features: { support: 'priority', versioning: 100, ai_features: true }
      },
      {
        plan_code: 'normal_pro_ultra',
        display_name: 'Pro Ultra Storage',
        description: 'High-capacity for heavy creators',
        price_monthly: 399,
        price_six_months: 1999,
        price_yearly: 3299,
        storage_gb: 3072,
        bandwidth_mbps: 200,
        bandwidth_burst_mbps: 400,
        max_concurrent_streams: 20,
        features: { support: 'priority', versioning: 150, ai_features: true }
      },
      {
        plan_code: 'normal_solo_max',
        display_name: 'Solo Max Storage',
        description: 'Massive personal storage',
        price_monthly: 599,
        price_six_months: 3199,
        price_yearly: 5499,
        storage_gb: 5120,
        bandwidth_mbps: 300,
        bandwidth_burst_mbps: 600,
        max_concurrent_streams: 25,
        features: { support: 'priority', versioning: 200, ai_features: true, team_sharing: false }
      }
    ],
    business: [
      {
        plan_code: 'normal_team',
        display_name: 'Team Storage',
        description: 'Collaboration-ready storage for teams',
        price_monthly: 599,
        price_six_months: 3499,
        price_yearly: 6499,
        storage_gb: 5120,
        bandwidth_mbps: 500,
        bandwidth_burst_mbps: 1000,
        max_concurrent_streams: 25,
        features: { support: '24/7', versioning: 100, ai_features: true, team_sharing: true },
        is_most_popular: true
      }
    ],
    enterprise: []
  },
  zk_plans: {
    individual: [
      {
        plan_code: 'zk_free',
        display_name: 'ZK Free Tier',
        description: 'Try zero-knowledge encryption for free',
        price_monthly: null,
        price_six_months: null,
        price_yearly: null,
        storage_gb: 2,
        bandwidth_mbps: 5,
        bandwidth_burst_mbps: 10,
        max_concurrent_streams: 1,
        features: { support: 'community', webauthn: true, encryption: 'zero_knowledge', versioning: 10, hardware_keys: 2, recovery_phrase: true },
        is_default: true
      },
      {
        plan_code: 'zk_personal',
        display_name: 'ZK Personal',
        description: 'Personal encrypted storage',
        price_monthly: 9.99,
        price_six_months: null,
        price_yearly: 99.99,
        storage_gb: 50,
        bandwidth_mbps: 10,
        bandwidth_burst_mbps: 20,
        max_concurrent_streams: 3,
        features: { support: 'standard', webauthn: true, encryption: 'zero_knowledge', versioning: 50, hardware_keys: 5, recovery_phrase: true }
      },
      {
        plan_code: 'zk_business',
        display_name: 'ZK Business',
        description: 'Business-grade encrypted storage',
        price_monthly: 29.99,
        price_six_months: null,
        price_yearly: 299.99,
        storage_gb: 200,
        bandwidth_mbps: 20,
        bandwidth_burst_mbps: 40,
        max_concurrent_streams: 5,
        features: { support: 'priority', webauthn: true, encryption: 'zero_knowledge', versioning: 100, hardware_keys: 10, recovery_phrase: true },
        is_most_popular: true
      },
      {
        plan_code: 'zk_enterprise',
        display_name: 'ZK Enterprise',
        description: 'Enterprise zero-knowledge vault',
        price_monthly: 99.99,
        price_six_months: null,
        price_yearly: 999.99,
        storage_gb: 1024,
        bandwidth_mbps: 50,
        bandwidth_burst_mbps: 100,
        max_concurrent_streams: 10,
        features: { support: '24/7', webauthn: true, encryption: 'zero_knowledge', versioning: 'unlimited', hardware_keys: 25, recovery_phrase: true }
      },
      {
        plan_code: 'zk_pro',
        display_name: 'ZK Pro',
        description: '1TB zero-knowledge encrypted vault',
        price_monthly: 399,
        price_six_months: 1699,
        price_yearly: 2999,
        storage_gb: 1024,
        bandwidth_mbps: 20,
        bandwidth_burst_mbps: 40,
        max_concurrent_streams: 5,
        features: { support: 'priority', webauthn: true, encryption: 'zero_knowledge', versioning: true, hardware_keys: 10, recovery_phrase: true }
      },
      {
        plan_code: 'zk_pro_plus',
        display_name: 'ZK Pro Plus',
        description: '2TB zero-knowledge encrypted storage',
        price_monthly: 699,
        price_six_months: 2999,
        price_yearly: 5499,
        storage_gb: 2048,
        bandwidth_mbps: 30,
        bandwidth_burst_mbps: 60,
        max_concurrent_streams: 7,
        features: { support: 'priority', webauthn: true, encryption: 'zero_knowledge', versioning: true, hardware_keys: 15, recovery_phrase: true }
      },
      {
        plan_code: 'zk_ultra',
        display_name: 'ZK Ultra',
        description: '3TB zero-knowledge encrypted vault',
        price_monthly: 999,
        price_six_months: 4499,
        price_yearly: 7999,
        storage_gb: 3072,
        bandwidth_mbps: 40,
        bandwidth_burst_mbps: 80,
        max_concurrent_streams: 10,
        features: { support: 'priority', webauthn: true, encryption: 'zero_knowledge', versioning: true, hardware_keys: 25, recovery_phrase: true }
      },
      {
        plan_code: 'zk_max',
        display_name: 'ZK Max',
        description: '5TB zero-knowledge encrypted personal vault',
        price_monthly: 1399,
        price_six_months: 6499,
        price_yearly: 11999,
        storage_gb: 5120,
        bandwidth_mbps: 60,
        bandwidth_burst_mbps: 120,
        max_concurrent_streams: 15,
        features: { support: 'priority', webauthn: true, encryption: 'zero_knowledge', versioning: true, hardware_keys: 40, recovery_phrase: true }
      }
    ],
    business: [],
    enterprise: []
  }
};

function PlanCard({ plan, serviceType, darkMode, onSelect }) {
  // Determine available billing cycles and default cycle
  const hasMonthly = plan.price_monthly !== null;
  const hasSixMonths = plan.price_six_months !== null;
  const hasYearly = plan.price_yearly !== null;
  const isFree = !hasMonthly && !hasSixMonths && !hasYearly;

  // Default to the first available billing cycle
  const getDefaultCycle = () => {
    if (hasMonthly) return 'monthly';
    if (hasSixMonths) return 'six_months';
    if (hasYearly) return 'yearly';
    return 'monthly'; // fallback for free plans
  };

  const [billingCycle, setBillingCycle] = useState(getDefaultCycle());

  const getPrice = () => {
    if (isFree) return 'Free';

    // For yearly-only plans, always show yearly price
    if (!hasMonthly && !hasSixMonths && hasYearly) {
      return `₹${plan.price_yearly}`;
    }

    // For plans with multiple billing options
    switch (billingCycle) {
      case 'monthly': return hasMonthly ? `₹${plan.price_monthly}` : `₹${plan.price_yearly}`;
      case 'six_months': return hasSixMonths ? `₹${plan.price_six_months}` : `₹${plan.price_yearly}`;
      case 'yearly': return hasYearly ? `₹${plan.price_yearly}` : `₹${plan.price_monthly}`;
      default: return `₹${plan.price_monthly || plan.price_yearly}`;
    }
  };

  const getFeaturesList = () => {
    const features = [];
    if (plan.features.support) {
      features.push(`${plan.features.support === '24/7' ? '24/7' : plan.features.support} Support`);
    }
    if (plan.features.versioning) {
      features.push(`${plan.features.versioning} File Versions`);
    }
    if (plan.features.ai_features) {
      features.push('AI Features');
    }
    if (plan.features.team_sharing) {
      features.push('Team Sharing');
    }
    if (plan.features.webauthn) {
      features.push('WebAuthn Authentication');
    }
    if (plan.features.hardware_keys) {
      features.push(`${plan.features.hardware_keys} Hardware Keys`);
    }
    if (plan.features.recovery_phrase) {
      features.push('Recovery Phrase');
    }
    if (plan.features.encryption === 'zero_knowledge') {
      features.push('Zero-Knowledge Encryption');
    }
    return features;
  };

  return (
    <div
      className={`
        relative rounded-2xl p-6 transition-all duration-300
        ${darkMode
          ? 'bg-gray-900/40 border-gray-800/50 hover:border-gray-700/80'
          : 'bg-white border-gray-200 hover:border-gray-300 shadow-sm hover:shadow-xl'
        }
        border ${plan.is_most_popular ? 'ring-2 ring-blue-500/50' : ''}
      `}
    >
      {plan.is_most_popular && (
        <div className={`absolute -top-3 right-4 px-3 py-1 rounded-full text-xs font-semibold ${
          darkMode ? 'bg-blue-500 text-white' : 'bg-blue-600 text-white'
        }`}>
          Most Popular
        </div>
      )}

      {plan.is_default && (
        <div className={`absolute -top-3 left-4 px-3 py-1 rounded-full text-xs font-semibold flex items-center gap-1 ${
          darkMode ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-green-50 text-green-700 border border-green-200'
        }`}>
          <Crown className="w-3 h-3" />
          Free
        </div>
      )}

      <div className="mb-4">
        <h3 className={`text-xl font-bold mb-1 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          {plan.display_name}
        </h3>
        <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          {plan.description}
        </p>
      </div>

      <div className="mb-4">
        <div className={`text-4xl font-bold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          {getPrice()}
        </div>

        {/* Show billing cycle buttons only for plans with multiple options */}
        {hasMonthly && (
          <>
            <div className="flex gap-2 mb-3">
              {hasMonthly && (
                <button
                  onClick={() => setBillingCycle('monthly')}
                  className={`px-2 py-1 text-xs rounded ${
                    billingCycle === 'monthly'
                      ? darkMode ? 'bg-blue-500 text-white' : 'bg-blue-600 text-white'
                      : darkMode ? 'bg-gray-800 text-gray-400 hover:bg-gray-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  Mo
                </button>
              )}
              {hasSixMonths && (
                <button
                  onClick={() => setBillingCycle('six_months')}
                  className={`px-2 py-1 text-xs rounded ${
                    billingCycle === 'six_months'
                      ? darkMode ? 'bg-blue-500 text-white' : 'bg-blue-600 text-white'
                      : darkMode ? 'bg-gray-800 text-gray-400 hover:bg-gray-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  6Mo
                </button>
              )}
              {hasYearly && (
                <button
                  onClick={() => setBillingCycle('yearly')}
                  className={`px-2 py-1 text-xs rounded ${
                    billingCycle === 'yearly'
                      ? darkMode ? 'bg-blue-500 text-white' : 'bg-blue-600 text-white'
                      : darkMode ? 'bg-gray-800 text-gray-400 hover:bg-gray-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  Yr
                </button>
              )}
            </div>
            <div className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
              per {billingCycle === 'monthly' ? 'month' : billingCycle === 'six_months' ? '6 months' : 'year'}
            </div>
          </>
        )}

        {/* For yearly-only plans, show a label */}
        {!hasMonthly && !hasSixMonths && hasYearly && (
          <div className={`text-xs font-medium ${darkMode ? 'text-blue-400' : 'text-blue-600'}`}>
            Billed Yearly
          </div>
        )}
      </div>

      <div className={`space-y-2 mb-4 pb-4 border-b ${
        darkMode ? 'border-gray-800' : 'border-gray-200'
      }`}>
        <div className={`flex items-center gap-2 text-sm ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
          <HardDrive className={`w-4 h-4 ${darkMode ? 'text-blue-400' : 'text-blue-600'}`} />
          <span className="font-semibold">
            {plan.storage_gb >= 1024
              ? `${(plan.storage_gb / 1024).toFixed(0)} TB`
              : `${plan.storage_gb} GB`}
          </span>
          <span className={darkMode ? 'text-gray-500' : 'text-gray-500'}>Storage</span>
        </div>
        <div className={`flex items-center gap-2 text-sm ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
          <Gauge className={`w-4 h-4 ${darkMode ? 'text-green-400' : 'text-green-600'}`} />
          <span className="font-semibold">{plan.bandwidth_mbps} Mbps</span>
          <span className={darkMode ? 'text-gray-500' : 'text-gray-500'}>Bandwidth</span>
        </div>
        <div className={`flex items-center gap-2 text-sm ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
          <Zap className={`w-4 h-4 ${darkMode ? 'text-yellow-400' : 'text-yellow-600'}`} />
          <span className="font-semibold">{plan.max_concurrent_streams}</span>
          <span className={darkMode ? 'text-gray-500' : 'text-gray-500'}>Concurrent Streams</span>
        </div>
      </div>

      <div className="space-y-2 mb-6">
        {getFeaturesList().map((feature, index) => (
          <div key={index} className="flex items-start gap-2">
            <Check className={`w-4 h-4 flex-shrink-0 mt-0.5 ${
              darkMode ? 'text-green-400' : 'text-green-600'
            }`} />
            <span className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
              {feature}
            </span>
          </div>
        ))}
      </div>

      <button
        onClick={() => onSelect(plan.plan_code, serviceType, billingCycle)}
        className={`
          w-full py-3 px-4 rounded-lg font-semibold transition-all duration-200
          flex items-center justify-center gap-2
          ${darkMode
            ? 'bg-blue-600 hover:bg-blue-700 text-white'
            : 'bg-blue-600 hover:bg-blue-700 text-white'
          }
        `}
      >
        Get Started
        <ArrowRight className="w-4 h-4" />
      </button>
    </div>
  );
}

export default function PricingPage() {
  const navigate = useNavigate();
  const { darkMode, toggleTheme } = useTheme();
  const { isAuthenticated, user } = useAuth();
  const [edgeCategory, setEdgeCategory] = useState('individual');
  const [zkCategory, setZkCategory] = useState('individual');

  // API data state
  const [edgePlans, setEdgePlans] = useState({ individual: [], business: [], enterprise: [] });
  const [zkPlans, setZkPlans] = useState({ individual: [], business: [], enterprise: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  // Fetch plans from API
  useEffect(() => {
    const fetchPlans = async () => {
      setLoading(true);
      try {
        // Import API config
        const API_CONFIG = (await import('../../config/api.js')).default;

        // Fetch Normal Storage plans
        const edgeResponse = await fetch(`${API_CONFIG.STORAGE_API}/api/v1/auth/plans?service_type=normal`, {
          credentials: 'include'
        });
        const edgeData = await edgeResponse.json();

        // Fetch ZK Encryption plans
        const zkResponse = await fetch(`${API_CONFIG.STORAGE_API}/api/v1/auth/plans?service_type=zk`, {
          credentials: 'include'
        });
        const zkData = await zkResponse.json();

        // Set the categorized plans
        setEdgePlans(edgeData.plans || { individual: [], business: [], enterprise: [] });
        setZkPlans(zkData.plans || { individual: [], business: [], enterprise: [] });
      } catch (err) {
        console.error('Failed to fetch plans:', err);
        setError('Failed to load pricing plans. Please try again later.');
        // Fallback to mock data on error
        setEdgePlans(mockPlansData.edge_plans);
        setZkPlans(mockPlansData.zk_plans);
      } finally {
        setLoading(false);
      }
    };

    fetchPlans();
  }, []);

  const handlePlanSelect = (planCode, serviceType, billingCycle) => {
    if (!isAuthenticated || !user) {
      // Non-logged-in user: Redirect to auth with plan pre-selected
      navigate(`/auth?plan=${planCode}&service=${serviceType}&billing=${billingCycle}`);
      return;
    }

    // Logged-in user: Redirect to dashboard homepage
    // They can access "Billing & Plans" from sidebar to complete the upgrade
    // TODO: Integrate payment flow directly on pricing page
    navigate('/');
  };

  const categories = ['individual', 'business', 'enterprise'];
  const categoryLabels = {
    individual: 'Individual',
    business: 'Business',
    enterprise: 'Enterprise'
  };

  return (
    <div className={`min-h-screen ${darkMode ? 'dark bg-gray-900' : 'bg-gray-50'}`}>
      {/* Header */}
      <nav className={`fixed top-0 left-0 right-0 z-50 backdrop-blur-xl border-b transition-colors ${
        darkMode 
          ? 'border-white/5 bg-black/40' 
          : 'border-gray-200/80 bg-white/80 shadow-sm'
      }`}>
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => navigate('/auth')}>
            <div className="relative">
              <div className={`absolute inset-0 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl blur-lg ${
                darkMode ? 'opacity-50' : 'opacity-40'
              }`} />
              <div className="relative bg-gradient-to-br from-blue-500 to-purple-600 p-2.5 rounded-xl shadow-lg">
                <Cloud className="text-white w-5 h-5" />
              </div>
            </div>
            <span className={`font-bold text-lg tracking-tight ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Edge Cloud Storage
            </span>
          </div>
          
          <div className="flex items-center gap-4">
            <Link
              to="#"
              className={`text-sm font-medium transition-colors ${
                darkMode
                  ? 'text-gray-300 hover:text-white'
                  : 'text-gray-700 hover:text-gray-900'
              }`}
            >
              About
            </Link>
            <Link
              to="#"
              className={`text-sm font-medium transition-colors ${
                darkMode
                  ? 'text-gray-300 hover:text-white'
                  : 'text-gray-700 hover:text-gray-900'
              }`}
            >
              Products
            </Link>
            <Link
              to="/pricing"
              className={`text-sm font-medium transition-colors ${
                darkMode
                  ? 'text-blue-400 hover:text-blue-300'
                  : 'text-blue-600 hover:text-blue-700'
              }`}
            >
              Pricing
            </Link>
            <button
              onClick={toggleTheme}
              className={`p-2.5 rounded-xl border transition-all ${
                darkMode
                  ? 'hover:bg-white/5 border-white/10 hover:border-white/20 text-white'
                  : 'hover:bg-gray-50 border-gray-200 hover:border-gray-300 text-gray-700 shadow-sm hover:shadow'
              }`}
            >
              {darkMode ? <Sun size={18} /> : <Moon size={18} />}
            </button>
          </div>
        </div>
      </nav>

      <main className="pt-32 pb-20 px-6">
        <div className="max-w-7xl mx-auto">
          {/* Hero Section */}
          <div className="text-center mb-16">
            <h1 className={`text-5xl md:text-6xl font-bold tracking-tight mb-4 ${
              darkMode ? 'text-white' : 'text-gray-900'
            }`}>
              Simple, Transparent{' '}
              <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-purple-400 to-cyan-400">
                Pricing
              </span>
            </h1>
            <p className={`text-xl md:text-2xl max-w-2xl mx-auto ${
              darkMode ? 'text-gray-400' : 'text-gray-600'
            }`}>
              Choose the perfect plan for your needs. All plans include our core features.
            </p>
          </div>

          {/* Edge Storage Section */}
          <section className="mb-20">
            <div className="flex items-center gap-3 mb-8">
              <div className={`p-3 rounded-xl ${
                darkMode ? 'bg-blue-500/20' : 'bg-blue-100'
              }`}>
                <Cloud className={`w-6 h-6 ${darkMode ? 'text-blue-400' : 'text-blue-600'}`} />
              </div>
              <div>
                <h2 className={`text-3xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  Edge Storage
                </h2>
                <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  High-performance cloud storage with AI-powered features
                </p>
              </div>
            </div>

            {/* Category Tabs */}
            <div className="flex gap-2 mb-8 flex-wrap">
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setEdgeCategory(cat)}
                  className={`px-6 py-2 rounded-lg font-medium transition-all ${
                    edgeCategory === cat
                      ? darkMode
                        ? 'bg-blue-600 text-white'
                        : 'bg-blue-600 text-white'
                      : darkMode
                      ? 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                      : 'bg-white text-gray-700 hover:bg-gray-50 border border-gray-200'
                  }`}
                >
                  {categoryLabels[cat]}
                </button>
              ))}
            </div>

            {/* Plans Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {loading ? (
                <div className="col-span-full text-center py-12">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
                  <p className={`mt-4 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>Loading plans...</p>
                </div>
              ) : edgePlans[edgeCategory]?.length > 0 ? (
                edgePlans[edgeCategory].map((plan) => (
                  <PlanCard
                    key={plan.plan_code}
                    plan={plan}
                    serviceType="edge"
                    darkMode={darkMode}
                    onSelect={handlePlanSelect}
                  />
                ))
              ) : (
                <div className={`col-span-full text-center py-12 rounded-2xl border ${
                  darkMode ? 'border-gray-800 bg-gray-900/40' : 'border-gray-200 bg-white'
                }`}>
                  <p className={darkMode ? 'text-gray-400' : 'text-gray-600'}>
                    {categoryLabels[edgeCategory]} plans coming soon
                  </p>
                </div>
              )}
            </div>
          </section>

          {/* Zero-Knowledge Encryption Section */}
          <section>
            <div className="flex items-center gap-3 mb-8">
              <div className={`p-3 rounded-xl ${
                darkMode ? 'bg-purple-500/20' : 'bg-purple-100'
              }`}>
                <Shield className={`w-6 h-6 ${darkMode ? 'text-purple-400' : 'text-purple-600'}`} />
              </div>
              <div>
                <h2 className={`text-3xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  Zero-Knowledge Encryption
                </h2>
                <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  Client-side encryption where you control the keys
                </p>
              </div>
            </div>

            {/* Category Tabs */}
            <div className="flex gap-2 mb-8 flex-wrap">
              {categories.map((cat) => (
                <button
                  key={cat}
                  onClick={() => setZkCategory(cat)}
                  className={`px-6 py-2 rounded-lg font-medium transition-all ${
                    zkCategory === cat
                      ? darkMode
                        ? 'bg-purple-600 text-white'
                        : 'bg-purple-600 text-white'
                      : darkMode
                      ? 'bg-gray-800 text-gray-300 hover:bg-gray-700'
                      : 'bg-white text-gray-700 hover:bg-gray-50 border border-gray-200'
                  }`}
                >
                  {categoryLabels[cat]}
                </button>
              ))}
            </div>

            {/* Plans Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {loading ? (
                <div className="col-span-full text-center py-12">
                  <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
                  <p className={`mt-4 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>Loading plans...</p>
                </div>
              ) : zkPlans[zkCategory]?.length > 0 ? (
                zkPlans[zkCategory].map((plan) => (
                  <PlanCard
                    key={plan.plan_code}
                    plan={plan}
                    serviceType="zk"
                    darkMode={darkMode}
                    onSelect={handlePlanSelect}
                  />
                ))
              ) : (
                <div className={`col-span-full text-center py-12 rounded-2xl border ${
                  darkMode ? 'border-gray-800 bg-gray-900/40' : 'border-gray-200 bg-white'
                }`}>
                  <p className={darkMode ? 'text-gray-400' : 'text-gray-600'}>
                    {categoryLabels[zkCategory]} plans coming soon
                  </p>
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
