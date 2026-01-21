import React, { useState, useEffect } from 'react';
import { Crown, X, ArrowRight, TrendingUp, Shield, Lock, Sparkles } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useSubscription } from '../../contexts/SubscriptionContext';
import { useAuth } from '../../contexts/AuthContext';

export default function FreeAccountUpgradeBanner({ darkMode }) {
  const navigate = useNavigate();
  const { subscription, loading } = useSubscription();
  const { zkEnabled } = useAuth();
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    if (loading) return;

    // Only show for free tier users
    const isFree = subscription?.plan?.tier_name === 'free' ||
                   subscription?.plan?.plan_code?.includes('free') ||
                   subscription?.tier_name === 'free' ||
                   subscription?.plan_code?.includes('free');

    if (isFree && !isPermanentlyDismissed()) {
      setIsVisible(true);
    }
  }, [subscription, loading]);

  const isPermanentlyDismissed = () => {
    return localStorage.getItem('free_upgrade_banner_dismissed') === 'true';
  };

  const handleDismiss = () => {
    localStorage.setItem('free_upgrade_banner_dismissed', 'true');
    setIsVisible(false);
  };

  const handleUpgrade = () => {
    navigate('/pricing');
  };

  if (loading || !isVisible) {
    return null;
  }

  // ZK Premium Banner - Enhanced security-focused design
  if (zkEnabled) {
    return (
      <div className={`relative overflow-hidden bg-gradient-to-br from-indigo-600 via-purple-600 to-pink-600 rounded-xl p-0.5 mb-4 shadow-lg ${
        darkMode ? 'shadow-purple-900/50' : 'shadow-purple-500/30'
      }`}>
        {/* Inner container with dark background */}
        <div className={`relative bg-gradient-to-br ${
          darkMode
            ? 'from-gray-900 via-gray-900 to-gray-800'
            : 'from-white via-purple-50 to-indigo-50'
        } rounded-lg p-5`}>
          {/* Sparkle effect overlay */}
          <div className="absolute top-2 right-20 opacity-20">
            <Sparkles className="text-purple-500" size={24} />
          </div>

          <div className="flex items-start gap-4">
            {/* Premium Icon with Glow */}
            <div className="relative">
              <div className="absolute inset-0 bg-gradient-to-br from-purple-600 to-pink-600 rounded-xl blur-md opacity-50"></div>
              <div className="relative p-3 bg-gradient-to-br from-purple-600 to-pink-600 rounded-xl flex-shrink-0">
                <Shield className="text-white" size={24} />
              </div>
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className={`font-bold text-lg ${
                      darkMode ? 'text-white' : 'text-gray-900'
                    }`}>
                      Unlock Zero-Knowledge Premium
                    </h3>
                    <span className="px-2 py-0.5 text-xs font-bold bg-gradient-to-r from-yellow-400 to-orange-400 text-gray-900 rounded-full">
                      EXCLUSIVE
                    </span>
                  </div>

                  <p className={`text-sm ${
                    darkMode ? 'text-gray-300' : 'text-gray-700'
                  } mb-4`}>
                    Enterprise-grade encryption with military-level security. Your data, absolutely unreadable by anyone but you.
                  </p>

                  {/* Premium Benefits with Icons */}
                  <div className={`space-y-2.5 text-sm ${
                    darkMode ? 'text-gray-200' : 'text-gray-800'
                  }`}>
                    <div className="flex items-center gap-3">
                      <div className="p-1.5 bg-purple-600/20 rounded-lg">
                        <Lock className="text-purple-600 dark:text-purple-400" size={14} />
                      </div>
                      <span className="font-medium">Up to 1TB Zero-Knowledge Encrypted Storage</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="p-1.5 bg-indigo-600/20 rounded-lg">
                        <Shield className="text-indigo-600 dark:text-indigo-400" size={14} />
                      </div>
                      <span className="font-medium">Military-Grade E2E Encryption (AES-256-GCM)</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="p-1.5 bg-pink-600/20 rounded-lg">
                        <Sparkles className="text-pink-600 dark:text-pink-400" size={14} />
                      </div>
                      <span className="font-medium">Priority Support & Advanced Security Features</span>
                    </div>
                  </div>

                  {/* Pricing Badge */}
                  <div className="mt-4 inline-flex items-center gap-2 px-3 py-1 bg-gradient-to-r from-purple-600/10 to-pink-600/10 border border-purple-600/20 rounded-lg">
                    <span className={`text-xs ${
                      darkMode ? 'text-gray-400' : 'text-gray-600'
                    }`}>
                      Starting at
                    </span>
                    <span className="text-lg font-bold bg-gradient-to-r from-purple-600 to-pink-600 bg-clip-text text-transparent">
                      ₹1,499/year
                    </span>
                  </div>

                  {/* Action Button */}
                  <div className="mt-5">
                    <button
                      onClick={handleUpgrade}
                      className="inline-flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-700 hover:to-pink-700 text-white rounded-lg font-semibold text-sm transition-all shadow-lg shadow-purple-500/30 hover:shadow-purple-500/50"
                    >
                      <Shield size={16} />
                      Upgrade to Premium
                      <ArrowRight size={16} />
                    </button>
                  </div>
                </div>

                {/* Dismiss Button */}
                <button
                  onClick={handleDismiss}
                  className={`${
                    darkMode ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'
                  } transition-colors flex-shrink-0 mt-1`}
                  aria-label="Dismiss permanently"
                >
                  <X size={18} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Normal Storage Banner - Standard design
  return (
    <div className={`bg-gradient-to-r from-purple-50 to-blue-50 border border-purple-200 rounded-lg p-4 mb-4 ${
      darkMode ? 'dark:from-purple-900/20 dark:to-blue-900/20 dark:border-purple-800' : ''
    }`}>
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className="p-2 bg-purple-100 dark:bg-purple-900/50 rounded-lg flex-shrink-0">
          <Crown className="text-purple-600 dark:text-purple-400" size={20} />
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1">
              <h3 className={`font-semibold ${darkMode ? 'text-purple-300' : 'text-purple-900'} flex items-center gap-2`}>
                <TrendingUp size={16} />
                Upgrade Your Storage
              </h3>
              <p className={`text-sm ${darkMode ? 'text-purple-400' : 'text-purple-700'} mt-1`}>
                Unlock more storage, faster speeds, and premium features with our paid plans.
              </p>

              {/* Benefits */}
              <div className={`mt-3 space-y-1 text-sm ${darkMode ? 'text-purple-300' : 'text-purple-800'}`}>
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-purple-500"></div>
                  <span>Up to 5TB of storage</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-purple-500"></div>
                  <span>Priority support & AI features</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-1.5 h-1.5 rounded-full bg-purple-500"></div>
                  <span>Starting at just ₹899/year</span>
                </div>
              </div>

              {/* Action Button */}
              <div className="mt-4">
                <button
                  onClick={handleUpgrade}
                  className="inline-flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium text-sm transition-colors"
                >
                  View Plans
                  <ArrowRight size={16} />
                </button>
              </div>
            </div>

            {/* Dismiss Button */}
            <button
              onClick={handleDismiss}
              className="text-gray-400 hover:text-gray-600 transition-colors flex-shrink-0"
              aria-label="Dismiss permanently"
            >
              <X size={18} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
