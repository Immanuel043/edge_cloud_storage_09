import React, { useState, useRef, useEffect, useCallback } from 'react';
import * as zkEncryptionService from '../../services/zkEncryptionService';
import { useNavigate, Link } from 'react-router-dom';
import {
  Sun,
  Moon,
  Cloud,
  Shield,
  Zap,
  Database,
  Lock,
  Search,
  Share2,
  ArrowRight,
  Layers,
  Server,
  Brain,
  Globe,
  Video,
  ScanLine,
  History,
  ShieldCheck,
  FileText,
} from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import {
  validateEmail,
  validatePassword,
  sanitizeInput,
  validatePasswordStrength,
  type PasswordStrengthResult,
} from '../../utils/security';
import { authService } from '../../services/authService';
import * as zkAuthService from '../../services/zkAuthService';
import { ZK_STORAGE } from '../../config/constants';
import RecoveryPhraseSetup from './RecoveryPhraseSetup';
import RecoveryPhraseConfirm from './RecoveryPhraseConfirm';
import RecoveryModal from './RecoveryModal';
import ForgotPasswordModal from './ForgotPasswordModal';
import PasswordStrengthMeter from './PasswordStrengthMeter';
import VerificationCodeInput from './VerificationCodeInput';
import type {
  AuthFormData,
  FieldErrors,
  AuthMode,
  RegistrationStep,
  BentoGridProps,
  BentoCardProps,
  FloatingOrbProps,
  BentoSize,
  GlowColor,
  RecoveryCompleteData,
} from './types';
import { getErrorMessage } from './types';
import { Banner, Button, FormField, IconButton, Input, Tabs, TabsList, TabsTrigger } from '@/components/ui';
import { cn } from '@/lib/cn';

// ==================== Bento Grid Components ====================

/**
 * BentoGrid container component
 */
const BentoGrid: React.FC<BentoGridProps> = ({ children, className = '' }) => {
  return (
    <div
      className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 auto-rows-[minmax(160px,auto)] max-w-[88rem] mx-auto w-full px-6 ${className}`}
    >
      {children}
    </div>
  );
};

/**
 * Size class mapping for BentoCard
 */
const sizeClasses: Record<BentoSize, string> = {
  normal: 'col-span-1 row-span-1',
  large: 'sm:col-span-2 lg:col-span-2 row-span-2',
  tall: 'col-span-1 row-span-2',
  wide: 'sm:col-span-2 lg:col-span-2 row-span-1',
};

/**
 * Glow color class mapping for dark mode
 */
const glowColorsDark: Record<GlowColor, string> = {
  blue: 'group-hover:shadow-blue-500/20',
  purple: 'group-hover:shadow-purple-500/20',
  green: 'group-hover:shadow-green-500/20',
  cyan: 'group-hover:shadow-cyan-500/20',
  pink: 'group-hover:shadow-pink-500/20',
  orange: 'group-hover:shadow-orange-500/20',
  indigo: 'group-hover:shadow-indigo-500/20',
  yellow: 'group-hover:shadow-yellow-500/20',
};

/**
 * Glow color class mapping for light mode
 */
const glowColorsLight: Record<GlowColor, string> = {
  blue: 'group-hover:shadow-blue-500/10',
  purple: 'group-hover:shadow-purple-500/10',
  green: 'group-hover:shadow-green-500/10',
  cyan: 'group-hover:shadow-cyan-500/10',
  pink: 'group-hover:shadow-pink-500/10',
  orange: 'group-hover:shadow-orange-500/10',
  indigo: 'group-hover:shadow-indigo-500/10',
  yellow: 'group-hover:shadow-yellow-500/10',
};

/**
 * BentoCard component for feature display
 */
const BentoCard: React.FC<BentoCardProps> = ({
  title,
  description,
  icon: Icon,
  className = '',
  children,
  background,
  gradient,
  size = 'normal',
  glowColor = 'blue',
  darkMode = true,
}) => {
  const glowColors = darkMode ? glowColorsDark : glowColorsLight;

  return (
    <div
      className={`
      relative overflow-hidden rounded-2xl group cursor-default
      ${
        darkMode
          ? 'bg-gray-900/40 border-gray-800/50 hover:border-gray-700/80'
          : 'bg-white border-gray-200 hover:border-gray-300 shadow-sm hover:shadow-lg'
      }
      border transition-all duration-500 hover:-translate-y-1
      backdrop-blur-xl ${glowColors[glowColor]}
      ${sizeClasses[size]}
      ${className}
    `}
    >
      {/* Gradient overlay */}
      {gradient && <div className={`absolute inset-0 opacity-30 ${gradient}`} />}

      {/* Custom background */}
      {background && (
        <div className="absolute inset-0 z-0 opacity-40 transition-opacity duration-500 group-hover:opacity-60">
          {background}
        </div>
      )}

      {/* Content */}
      <div className="relative z-10 p-5 h-full flex flex-col">
        <div className="flex items-center gap-3 mb-2">
          <div
            className={`p-2 rounded-xl border transition-all duration-500 group-hover:scale-110 group-hover:rotate-3 ${
              darkMode
                ? 'bg-white/5 border-white/10 text-white/80 group-hover:text-white'
                : 'bg-gray-50 border-gray-200 text-gray-700 group-hover:text-gray-900 shadow-sm'
            }`}
          >
            <Icon size={18} />
          </div>
          <h3
            className={`font-semibold text-sm tracking-tight ${
              darkMode ? 'text-white/90' : 'text-gray-900'
            }`}
          >
            {title}
          </h3>
        </div>

        <p
          className={`text-xs leading-relaxed mb-3 flex-shrink-0 ${
            darkMode ? 'text-gray-400' : 'text-gray-600'
          }`}
        >
          {description}
        </p>

        {children && <div className="mt-auto">{children}</div>}
      </div>

      {/* Hover shine effect */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none">
        <div
          className={`absolute inset-0 bg-gradient-to-br ${
            darkMode ? 'from-white/5' : 'from-white/50'
          } via-transparent to-transparent`}
        />
      </div>
    </div>
  );
};

/**
 * FloatingOrb background element
 */
const FloatingOrb: React.FC<FloatingOrbProps> = ({
  className = '',
  delay = 0,
  darkMode = true,
}) => (
  <div
    className={`absolute rounded-full blur-3xl animate-float ${className} ${
      !darkMode ? 'opacity-30' : ''
    }`}
    style={{ animationDelay: `${delay}s` }}
  />
);

// ==================== Hooks ====================

/**
 * useCountUp - Animates a number from 0 to target when element enters viewport.
 * Respects prefers-reduced-motion.
 */
const useCountUp = (target: number, duration = 1200) => {
  const [value, setValue] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const hasAnimated = useRef(false);

  useEffect(() => {
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion) {
      setValue(target);
      return;
    }

    const el = ref.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !hasAnimated.current) {
          hasAnimated.current = true;
          const start = performance.now();
          const animate = (now: number) => {
            const elapsed = now - start;
            const progress = Math.min(elapsed / duration, 1);
            // ease-out cubic
            const eased = 1 - Math.pow(1 - progress, 3);
            setValue(Math.round(eased * target));
            if (progress < 1) {
              requestAnimationFrame(animate);
            }
          };
          requestAnimationFrame(animate);
        }
      },
      { threshold: 0.3 }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [target, duration]);

  return { value, ref };
};

// ==================== Main Component ====================

/**
 * AuthPage Component
 *
 * Main authentication page with login/register forms,
 * ZK encryption toggle, and feature showcase.
 */
const AuthPage: React.FC = () => {
  const navigate = useNavigate();
  const { darkMode, toggleTheme } = useTheme();
  const { login, loginZK, isAuthenticated, loading: authLoading } = useAuth();

  // Redirect to dashboard if already authenticated (handles ZK mode switch after registration)
  useEffect(() => {
    if (isAuthenticated && !authLoading) {
      navigate('/');
    }
  }, [isAuthenticated, authLoading, navigate]);

  // Auth State
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [enableZK, setEnableZK] = useState<boolean>(false);
  const [showRecovery, setShowRecovery] = useState<boolean>(false);
  const [showForgotPassword, setShowForgotPassword] = useState<boolean>(false);
  const [forgotPasswordEmail, setForgotPasswordEmail] = useState<string>('');

  // Email Verification State
  const [registrationStep, setRegistrationStep] = useState<RegistrationStep>('form');
  const [verificationEmail, setVerificationEmail] = useState<string>('');
  const [pendingFormData, setPendingFormData] = useState<AuthFormData | null>(null);

  // Recovery phrase flow state
  const [recoveryPhrase, setRecoveryPhrase] = useState<string>('');
  const [showRecoverySetup, setShowRecoverySetup] = useState<boolean>(false);
  const [showRecoveryConfirm, setShowRecoveryConfirm] = useState<boolean>(false);

  // Input State
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [failedAttempts, setFailedAttempts] = useState<number>(0);
  const [lockoutUntil, setLockoutUntil] = useState<number | null>(null);

  // Refs
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const usernameRef = useRef<HTMLInputElement>(null);
  const confirmPasswordRef = useRef<HTMLInputElement>(null);

  const [formData, setFormData] = useState<AuthFormData>({
    email: '',
    password: '',
    confirmPassword: '',
    username: '',
    userType: 'individual',
    planCode: null,
    billingCycle: 'monthly',
  });

  // URL parameter state for pre-selected plan
  const [planFromUrl, setPlanFromUrl] = useState<string | null>(null);

  const passwordStrength: PasswordStrengthResult | null = formData.password
    ? validatePasswordStrength(formData.password)
    : null;

  // Animated stat counters
  const uploadSpeed = useCountUp(40);
  const maxCapacity = useCountUp(8);
  const uptimeVal = useCountUp(999);
  const storageSavings = useCountUp(60);

  // Extract plan, service, and billing cycle from URL parameters
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const plan = params.get('plan');
    const service = params.get('service');
    const billing = params.get('billing');

    if (plan) {
      setPlanFromUrl(plan);
      setFormData((prev) => ({
        ...prev,
        planCode: plan,
        billingCycle: (billing as 'monthly' | 'six_months' | 'yearly') || 'monthly',
      }));
    }

    if (service === 'zk') {
      setEnableZK(true);
    }
  }, []);

  // Lockout timer
  useEffect(() => {
    if (lockoutUntil) {
      const timer = setInterval(() => {
        if (Date.now() >= lockoutUntil) {
          setLockoutUntil(null);
          setFailedAttempts(0);
        }
      }, 1000);
      return () => clearInterval(timer);
    }
  }, [lockoutUntil]);

  const getLockoutRemaining = useCallback((): number => {
    if (!lockoutUntil) return 0;
    return Math.max(0, Math.ceil((lockoutUntil - Date.now()) / 1000));
  }, [lockoutUntil]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>): Promise<void> => {
    e.preventDefault();
    setError('');
    setFieldErrors({});

    if (lockoutUntil && Date.now() < lockoutUntil) {
      setError(`Too many failed attempts. Please wait ${getLockoutRemaining()} seconds.`);
      return;
    }

    // Validation
    if (!validateEmail(formData.email)) {
      setFieldErrors((prev) => ({ ...prev, email: 'Please enter a valid email address' }));
      emailRef.current?.focus();
      return;
    }

    if (authMode === 'login') {
      // LOGIN FLOW
      if (!validatePassword(formData.password)) {
        setFieldErrors((prev) => ({
          ...prev,
          password: 'Password must be at least 8 characters',
        }));
        passwordRef.current?.focus();
        return;
      }

      setLoading(true);
      try {
        if (enableZK) {
          if (!loginZK) {
            throw new Error('ZK login is not available');
          }
          await loginZK(formData.email, formData.password);
          console.log('ZK login complete - activating ZK mode');
          // Navigation is handled by the useEffect watching isAuthenticated
        } else {
          await login(formData.email, formData.password);
          console.log('Normal login complete - redirecting to homepage');
          setTimeout(() => {
            navigate('/');
          }, 100);
        }
        setFailedAttempts(0);
      } catch (err: unknown) {
        const errorMessage = getErrorMessage(err) || 'Invalid credentials';
        setError(errorMessage);
        setLoading(false);

        const newFailedAttempts = failedAttempts + 1;
        setFailedAttempts(newFailedAttempts);
        if (newFailedAttempts >= 5) {
          setLockoutUntil(Date.now() + 60000);
          setError('Too many failed attempts. Please wait 60 seconds.');
        }
      }
    } else {
      // REGISTRATION FLOW
      if (formData.username.length < 3) {
        setFieldErrors((prev) => ({
          ...prev,
          username: 'Username must be at least 3 characters',
        }));
        usernameRef.current?.focus();
        return;
      }

      if (!validatePassword(formData.password)) {
        setFieldErrors((prev) => ({
          ...prev,
          password: 'Password must be at least 8 characters',
        }));
        passwordRef.current?.focus();
        return;
      }

      if (passwordStrength && !passwordStrength.isValid) {
        setFieldErrors((prev) => ({
          ...prev,
          password: 'Password does not meet strength requirements',
        }));
        passwordRef.current?.focus();
        return;
      }

      if (formData.password !== formData.confirmPassword) {
        setFieldErrors((prev) => ({ ...prev, confirmPassword: 'Passwords do not match' }));
        confirmPasswordRef.current?.focus();
        return;
      }

      setLoading(true);

      try {
        const initMethod = enableZK ? 'registerZKInit' : 'registerInit';
        await authService[initMethod](formData.email);

        setVerificationEmail(formData.email);
        setPendingFormData(formData);
        setRegistrationStep('verify');
        setLoading(false);
      } catch (err: unknown) {
        const errorMessage = getErrorMessage(err) || 'Registration failed';
        setError(errorMessage);
        setLoading(false);
      }
    }
  };

  const handleVerificationCode = async (code: string): Promise<void> => {
    setError('');
    setLoading(true);

    try {
      const verifyMethod = enableZK ? 'registerZKVerify' : 'registerVerify';
      const verifyResponse = await authService[verifyMethod](verificationEmail, code) as {
        verified?: boolean;
        token?: string;
        verification_token?: string;
        message?: string;
      };

      // Handle both response formats
      const isVerified = verifyResponse.verified ?? !!verifyResponse.verification_token;
      const token = verifyResponse.token ?? verifyResponse.verification_token;

      if (isVerified && token) {
        await completeRegistration(token);
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err) || 'Invalid verification code');
      setLoading(false);
    }
  };

  const completeRegistration = async (token: string): Promise<void> => {
    try {
      if (!pendingFormData) {
        throw new Error('No pending form data');
      }

      const planCode = pendingFormData.planCode || (enableZK ? 'zk_pro' : 'normal_free');
      const billingCycle = pendingFormData.billingCycle || 'monthly';

      if (enableZK) {
        const zkData = await zkEncryptionService.generateZKRegistrationData(pendingFormData.password);

        // 1. Complete registration
        await authService.registerZKComplete(
          pendingFormData.email,
          pendingFormData.username,
          zkData.passwordHash,
          zkData,
          token,
          planCode,
          billingCycle
        );

        // 2. Login via direct API calls (sets HTTP-only auth cookie)
        //    We intentionally bypass standaloneLoginZK to avoid triggering
        //    the ZK mode switch (which remounts the tree and loses component state)
        const kdfParams = await zkAuthService.getKDFParams(pendingFormData.email);
        if (!kdfParams) throw new Error('Failed to get KDF parameters after registration');
        const passwordHash = await zkEncryptionService.getPasswordHashForLogin(
          pendingFormData.password,
          kdfParams.kdf_salt,
          kdfParams.kdf_iterations,
          kdfParams.kdf_algorithm as 'argon2id' | 'pbkdf2'
        );
        const loginResponse = await zkAuthService.loginZK(pendingFormData.email, passwordHash);

        // Store registration hint for ZKAuthProvider fast-path bootstrap
        // (avoids async getProfile() call which has race conditions during mode switch)
        sessionStorage.setItem('zkAuthComplete', JSON.stringify({
          userId: loginResponse.user_id,
          email: pendingFormData.email,
          username: pendingFormData.username,
          ts: Date.now(),
        }));

        // 3. Store ZK data in localStorage (but NOT ZK_ENABLED_KEY yet — prevents premature mode switch)
        const masterKeyIV = loginResponse.master_key_iv || kdfParams.kdf_iv || '';
        const zkDataObj = {
          kdfSalt: kdfParams.kdf_salt,
          kdfAlgorithm: kdfParams.kdf_algorithm,
          kdfIterations: kdfParams.kdf_iterations,
          encryptedMasterKey: loginResponse.encrypted_master_key,
          masterKeyIV,
          ...(kdfParams.kdf_memory !== undefined && { kdfMemory: kdfParams.kdf_memory }),
        };
        localStorage.setItem(ZK_STORAGE.ZK_DATA_KEY, JSON.stringify(zkDataObj));
        localStorage.setItem(ZK_STORAGE.ZK_EMAIL_KEY, pendingFormData.email);

        // 4. Generate recovery phrase (master key is already in memory from generateZKRegistrationData)
        let recoveryPhraseText = '';
        try {
          const recoveryData = zkEncryptionService.generateRecoveryPhraseData();
          await zkAuthService.enableRecoveryPhrase(
            recoveryData.recoveryEncryptedMasterKey,
            recoveryData.recoveryPhraseHash
          );
          localStorage.setItem(ZK_STORAGE.RECOVERY_ENABLED_KEY, 'true');
          recoveryPhraseText = recoveryData.recoveryPhrase;
        } catch (recoveryErr) {
          console.warn('Recovery phrase setup failed, will skip:', recoveryErr);
        }

        setLoading(false);

        if (recoveryPhraseText) {
          // Show recovery phrase modal — mode switch deferred to onConfirm/onSkip
          setRecoveryPhrase(recoveryPhraseText);
          setShowRecoverySetup(true);
        } else {
          // Recovery phrase failed — activate ZK mode (navigation handled by useEffect)
          console.log('ZK Registration complete (no recovery phrase) - activating ZK mode');
          localStorage.setItem(ZK_STORAGE.ZK_ENABLED_KEY, 'true');
          window.dispatchEvent(new CustomEvent('zk-mode-changed', { detail: { enabled: true } }));
        }
      } else {
        const result = await authService.registerComplete(
          pendingFormData.email,
          pendingFormData.username,
          pendingFormData.password,
          token,
          planCode,
          billingCycle
        );

        await login(pendingFormData.email, pendingFormData.password);

        setLoading(false);

        if (result.pending_upgrade) {
          const { plan_code, billing_cycle } = result.pending_upgrade;
          const billingParam = billing_cycle ? `&billing=${billing_cycle}` : '';
          console.log('Paid plan selected - redirecting to payment flow');
          setTimeout(() => {
            navigate(`/pricing?upgrade=${plan_code}&service=normal${billingParam}`);
          }, 100);
        } else {
          console.log('Normal registration complete - redirecting to homepage');
          setTimeout(() => {
            navigate('/');
          }, 100);
        }
      }
    } catch (err: unknown) {
      setError(getErrorMessage(err) || 'Registration failed');
      setLoading(false);
    }
  };

  const handleResendCode = async (): Promise<void> => {
    try {
      const resendMethod = enableZK ? 'resendZKVerificationCode' : 'resendVerificationCode';
      await authService[resendMethod](verificationEmail);
    } catch (err: unknown) {
      setError(getErrorMessage(err) || 'Failed to resend code');
    }
  };

  const handleBackToForm = (): void => {
    setRegistrationStep('form');
    setError('');
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const { name, value } = e.target;
    // Never sanitize password fields - sanitizeInput strips characters like <>"' which are valid in passwords
    const sanitizedValue = name === 'password' || name === 'confirmPassword' ? value : sanitizeInput(value);
    setFormData((prev) => ({ ...prev, [name]: sanitizedValue }));
    if (fieldErrors[name as keyof FieldErrors]) {
      setFieldErrors((prev) => ({ ...prev, [name]: null }));
    }
    if (error) setError('');
  };

  const checkZKStatus = useCallback(
    async (email: string): Promise<void> => {
      if (!email || !validateEmail(email) || authMode !== 'login') return;
      try {
        const kdfParams = await zkAuthService.getKDFParams(email);
        if (kdfParams) setEnableZK(true);
      } catch {
        // Ignore - user may not have ZK enabled
      }
    },
    [authMode]
  );

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>): void => {
    const { name, value } = e.target;
    if (name === 'email' && authMode === 'login' && value && validateEmail(value)) {
      void checkZKStatus(value);
    }
  };

  const handleRecoveryComplete = (data: RecoveryCompleteData): void => {
    setFormData((prev) => ({ ...prev, email: data.email, password: data.newPassword }));
    setShowRecovery(false);
    setEnableZK(true);
  };

  // Feature pills data
  const featurePills = [
    { icon: Shield, label: 'AES-256 GCM', color: darkMode ? 'text-green-500' : 'text-green-600' },
    { icon: Brain, label: 'ML-Powered', color: darkMode ? 'text-purple-500' : 'text-purple-600' },
    { icon: Video, label: 'Video Optimization', color: darkMode ? 'text-blue-500' : 'text-blue-600' },
  ];

  // Storage tiers
  const storageTiers: Array<{ tier: string; colorClass: string }> = [
    {
      tier: 'Hot',
      colorClass: darkMode
        ? 'bg-red-500/20 text-red-400'
        : 'bg-red-50 text-red-600 border border-red-200',
    },
    {
      tier: 'Warm',
      colorClass: darkMode
        ? 'bg-yellow-500/20 text-yellow-400'
        : 'bg-yellow-50 text-yellow-600 border border-yellow-200',
    },
    {
      tier: 'Cold',
      colorClass: darkMode
        ? 'bg-blue-500/20 text-blue-400'
        : 'bg-blue-50 text-blue-600 border border-blue-200',
    },
  ];

  // Performance stats
  const stats = [
    { value: `${uploadSpeed.value} MB/s`, label: 'Upload Speed', icon: Zap, color: 'text-yellow-500', ref: uploadSpeed.ref },
    { value: `${maxCapacity.value} TB`, label: 'Max Capacity', icon: Database, color: 'text-blue-500', ref: maxCapacity.ref },
    { value: `${(uptimeVal.value / 10).toFixed(1)}%`, label: 'Uptime', icon: ShieldCheck, color: 'text-green-500', ref: uptimeVal.ref },
    { value: `${storageSavings.value}%`, label: 'Storage Savings', icon: Layers, color: 'text-purple-500', ref: storageSavings.ref },
  ];

  return (
    <div
      className={`min-h-screen font-sans selection:bg-blue-500/30 overflow-hidden transition-colors duration-300 ${
        darkMode
          ? 'bg-black text-white'
          : 'bg-gradient-to-br from-gray-50 via-white to-blue-50/30 text-gray-900'
      }`}
    >
      {/* Animated Background */}
      <div className="fixed inset-0 -z-10">
        {/* Grid pattern */}
        <div
          className={`absolute inset-0 bg-[size:64px_64px] ${
            darkMode
              ? 'bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)]'
              : 'bg-[linear-gradient(rgba(59,130,246,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(59,130,246,0.03)_1px,transparent_1px)]'
          }`}
        />

        {/* Floating orbs */}
        <FloatingOrb
          className={`w-[600px] h-[600px] top-[-200px] left-[-200px] ${
            darkMode ? 'bg-blue-600/20' : 'bg-blue-400/15'
          }`}
          delay={0}
          darkMode={darkMode}
        />
        <FloatingOrb
          className={`w-[500px] h-[500px] top-[40%] right-[-150px] ${
            darkMode ? 'bg-purple-600/15' : 'bg-purple-400/12'
          }`}
          delay={2}
          darkMode={darkMode}
        />
        <FloatingOrb
          className={`w-[400px] h-[400px] bottom-[-100px] left-[30%] ${
            darkMode ? 'bg-cyan-600/10' : 'bg-cyan-400/10'
          }`}
          delay={4}
          darkMode={darkMode}
        />

        {/* Radial gradient overlay */}
        <div
          className={`absolute inset-0 ${
            darkMode
              ? 'bg-[radial-gradient(ellipse_at_center,transparent_0%,black_70%)]'
              : 'bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.8)_0%,rgba(249,250,251,0.95)_70%)]'
          }`}
        />
      </div>

      {/* Navbar */}
      <nav
        className={`fixed top-0 w-full z-50 border-b backdrop-blur-xl transition-colors ${
          darkMode
            ? 'border-white/5 bg-black/40'
            : 'border-gray-200/80 bg-white/80 shadow-sm'
        }`}
      >
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div
            className="flex items-center gap-3 cursor-pointer"
            onClick={() => navigate('/auth')}
          >
            <div className="relative">
              <div
                className={`absolute inset-0 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl blur-lg ${
                  darkMode ? 'opacity-50' : 'opacity-40'
                }`}
              />
              <div className="relative bg-gradient-to-br from-blue-500 to-purple-600 p-2.5 rounded-xl shadow-lg">
                <Cloud className="text-white w-5 h-5" />
              </div>
            </div>
            <span
              className={`font-bold text-lg tracking-tight ${
                darkMode ? 'text-white' : 'text-gray-900'
              }`}
            >
              Edge Cloud Storage
            </span>
          </div>

          <div className="flex items-center gap-4">
            <Link
              to="#"
              className={`text-sm font-medium transition-colors ${
                darkMode ? 'text-gray-300 hover:text-white' : 'text-gray-700 hover:text-gray-900'
              }`}
            >
              About
            </Link>
            <Link
              to="#"
              className={`text-sm font-medium transition-colors ${
                darkMode ? 'text-gray-300 hover:text-white' : 'text-gray-700 hover:text-gray-900'
              }`}
            >
              Products
            </Link>
            <Link
              to="/pricing"
              className={`text-sm font-medium transition-colors ${
                darkMode ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-700'
              }`}
            >
              Pricing
            </Link>
            <IconButton
              variant="ghost"
              size="md"
              onClick={toggleTheme}
              aria-label={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            >
              {darkMode ? <Sun /> : <Moon />}
            </IconButton>
          </div>
        </div>
      </nav>

      <main className="pt-28 pb-20 px-6">
        <div className="max-w-7xl mx-auto">
          {/* Hero Section */}
          <div className="grid lg:grid-cols-2 gap-16 items-center mb-32 px-6">
            {/* Hero Left */}
            <div className="relative z-10">
              {/* Badge */}
              <div
                className={`animate-fade-up inline-flex items-center gap-2 px-4 py-2 rounded-full border mb-8 ${
                  darkMode
                    ? 'bg-gradient-to-r from-blue-500/10 to-purple-500/10 border-blue-500/20'
                    : 'bg-gradient-to-r from-blue-50 to-purple-50 border-blue-200 shadow-sm'
                }`}
                style={{ '--fade-delay': '0ms' } as React.CSSProperties}
              >
                <div className="relative flex h-2 w-2">
                  <span
                    className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                      darkMode ? 'bg-blue-400' : 'bg-blue-500'
                    }`}
                  />
                  <span
                    className={`relative inline-flex rounded-full h-2 w-2 ${
                      darkMode ? 'bg-blue-500' : 'bg-blue-600'
                    }`}
                  />
                </div>
                <span
                  className={`text-sm font-medium ${
                    darkMode ? 'text-blue-400' : 'text-blue-600'
                  }`}
                >
                  Zero-Knowledge Encryption
                </span>
              </div>

              {/* Main heading */}
              <h1 className="animate-fade-up text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.1] mb-8" style={{ '--fade-delay': '100ms' } as React.CSSProperties}>
                File Storage,{' '}
                <span className="relative">
                  <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-purple-400 to-cyan-400">
                    Reinvented.
                  </span>
                  <span className="absolute -inset-1 bg-gradient-to-r from-blue-500/20 via-purple-500/20 to-cyan-500/20 blur-2xl -z-10" />
                </span>
              </h1>

              {/* Subtitle */}
              <p
                className={`animate-fade-up text-lg md:text-xl leading-relaxed mb-10 max-w-lg ${
                  darkMode ? 'text-gray-400' : 'text-gray-700'
                }`}
                style={{ '--fade-delay': '200ms' } as React.CSSProperties}
              >
                Enterprise-grade security with consumer-level simplicity. Your data,
                encrypted with keys{' '}
                <span className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  only you hold
                </span>
                .
              </p>

              {/* Feature pills */}
              <div className="animate-fade-up flex flex-wrap gap-3" style={{ '--fade-delay': '300ms' } as React.CSSProperties}>
                {featurePills.map((item, i) => (
                  <div
                    key={i}
                    className={`flex items-center gap-2 px-4 py-2 rounded-full border transition-all ${
                      darkMode
                        ? 'bg-white/5 border-white/10 hover:border-white/20'
                        : 'bg-white border-gray-200 hover:border-blue-200 hover:shadow-md shadow-sm'
                    }`}
                  >
                    <item.icon className={item.color} size={14} />
                    <span
                      className={`text-sm font-medium ${
                        darkMode ? 'text-gray-300' : 'text-gray-700'
                      }`}
                    >
                      {item.label}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Auth Card Right */}
            <div className="animate-fade-up relative" style={{ '--fade-delay': '200ms' } as React.CSSProperties}>
              {/* Glow effect behind card */}
              <div
                className={`absolute -inset-4 bg-gradient-to-r from-blue-500/20 via-purple-500/20 to-cyan-500/20 rounded-3xl blur-3xl ${
                  darkMode ? 'opacity-50' : 'opacity-20'
                }`}
              />

              <div
                className={`relative p-8 rounded-2xl border backdrop-blur-2xl ${
                  darkMode
                    ? 'border-white/10 bg-gray-900/80 shadow-2xl'
                    : 'border-gray-200/80 bg-white/95 shadow-2xl shadow-gray-200/50'
                }`}
              >
                {/* Tab Switcher */}
                <Tabs
                  value={authMode}
                  onChange={(v) => setAuthMode(v as AuthMode)}
                  variant="pill"
                  className="mb-8"
                >
                  <TabsList className="w-full">
                    <TabsTrigger value="login" className="flex-1 justify-center">
                      Log in
                    </TabsTrigger>
                    <TabsTrigger value="register" className="flex-1 justify-center">
                      Sign up
                    </TabsTrigger>
                  </TabsList>
                </Tabs>

                {authMode === 'register' && registrationStep === 'verify' ? (
                  <VerificationCodeInput
                    email={verificationEmail}
                    onVerify={(code) => void handleVerificationCode(code)}
                    onResend={() => void handleResendCode()}
                    onBack={handleBackToForm}
                    darkMode={darkMode}
                    loading={loading}
                    error={error}
                    expiryMinutes={30}
                  />
                ) : (
                  <form onSubmit={(e) => void handleSubmit(e)} className="space-y-5">
                    {/* Email */}
                    <FormField label="Email" {...(fieldErrors.email ? { error: fieldErrors.email } : {})}>
                      <Input
                        ref={emailRef}
                        type="email"
                        name="email"
                        value={formData.email}
                        onChange={handleInputChange}
                        onBlur={handleBlur}
                        size="lg"
                        placeholder="name@company.com"
                      />
                    </FormField>

                    {/* Username (register only) */}
                    {authMode === 'register' && (
                      <FormField
                        label="Username"
                        {...(fieldErrors.username ? { error: fieldErrors.username } : {})}
                      >
                        <Input
                          ref={usernameRef}
                          type="text"
                          name="username"
                          value={formData.username}
                          onChange={handleInputChange}
                          size="lg"
                          placeholder="username"
                        />
                      </FormField>
                    )}

                    {/* Password */}
                    <div>
                      <FormField
                        label="Password"
                        {...(fieldErrors.password ? { error: fieldErrors.password } : {})}
                      >
                        <Input
                          ref={passwordRef}
                          name="password"
                          value={formData.password}
                          onChange={handleInputChange}
                          passwordReveal
                          size="lg"
                          placeholder="••••••••"
                        />
                      </FormField>
                      {authMode === 'register' && formData.password && (
                        <div className="mt-2">
                          <PasswordStrengthMeter
                            strengthData={passwordStrength}
                            darkMode={darkMode}
                            showRequirements={false}
                          />
                        </div>
                      )}
                    </div>

                    {/* Confirm Password (register only) */}
                    {authMode === 'register' && (
                      <FormField
                        label="Confirm password"
                        {...(fieldErrors.confirmPassword ? { error: fieldErrors.confirmPassword } : {})}
                      >
                        <Input
                          ref={confirmPasswordRef}
                          name="confirmPassword"
                          value={formData.confirmPassword}
                          onChange={handleInputChange}
                          passwordReveal
                          size="lg"
                          placeholder="••••••••"
                        />
                      </FormField>
                    )}

                    {/* Pre-selected Plan Indicator */}
                    {authMode === 'register' && planFromUrl && (
                      <div className="rounded-xl border border-primary/30 bg-primary/10 p-4">
                        <p className="text-body-sm text-fg">
                          Selected plan:{' '}
                          <strong className="font-semibold">
                            {planFromUrl
                              .split('_')
                              .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                              .join(' ')}
                          </strong>
                        </p>
                        <Link
                          to="/pricing"
                          className="mt-1 inline-block text-body-sm text-primary underline hover:text-primary-hover"
                        >
                          Change plan
                        </Link>
                      </div>
                    )}

                    {/* ZK Toggle */}
                    {/* TODO: Verify zkEnabled against server on login — currently the toggle can be
                        manually set without server verification. checkZKStatus partially handles this
                        via onBlur, but the user can still toggle ZK on for a non-ZK account. */}
                    <div
                      className={cn(
                        'rounded-xl border p-4 transition-colors duration-base',
                        enableZK
                          ? 'border-primary/30 bg-primary/10'
                          : 'border-border bg-surface-muted hover:border-border-strong'
                      )}
                    >
                      <label className="flex cursor-pointer items-start gap-3">
                        <input
                          type="checkbox"
                          checked={enableZK}
                          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            setEnableZK(e.target.checked)
                          }
                          className="mt-0.5 h-5 w-5 cursor-pointer rounded border-border text-primary focus-visible:shadow-focus focus-visible:outline-none"
                        />
                        <div className="flex-1">
                          <div className="mb-1 flex flex-wrap items-center gap-2">
                            <Shield
                              className={cn(
                                'h-4 w-4',
                                enableZK ? 'text-primary' : 'text-fg-subtle'
                              )}
                            />
                            <span className="text-body-sm font-semibold text-fg">
                              Zero-knowledge encryption
                            </span>
                            {authMode === 'register' && (
                              <span className="rounded-full bg-gradient-to-r from-primary to-accent px-2 py-0.5 text-[10px] font-bold uppercase text-white shadow-sm">
                                Recommended
                              </span>
                            )}
                          </div>
                          <p className="text-caption leading-relaxed text-fg-muted">
                            Client-side encryption. We can&apos;t see your data.
                          </p>
                        </div>
                      </label>
                    </div>

                    {/* Error */}
                    {error && (
                      <Banner variant="danger" role="alert">
                        {error}
                      </Banner>
                    )}

                    {/* Submit Button */}
                    <Button
                      type="submit"
                      variant="primary"
                      size="lg"
                      fullWidth
                      loading={loading}
                      disabled={loading || !!lockoutUntil}
                      rightIcon={!loading ? <ArrowRight className="h-4 w-4" /> : undefined}
                    >
                      {authMode === 'login' ? 'Continue' : 'Create account'}
                    </Button>
                  </form>
                )}

                {/* Forgot Password */}
                {authMode === 'login' && (
                  <div className="mt-6 text-center">
                    <button
                      type="button"
                      onClick={() => setShowForgotPassword(true)}
                      className="text-body-sm text-fg-muted transition-colors hover:text-fg"
                    >
                      Forgot your password?
                    </button>
                  </div>
                )}

                {/* OAuth Divider */}
                <div className="relative my-6">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-border" />
                  </div>
                  <div className="relative flex justify-center">
                    <span className="bg-surface px-4 text-body-sm text-fg-muted">
                      Or continue with
                    </span>
                  </div>
                </div>

                {/* OAuth Buttons */}
                <div className="grid grid-cols-2 gap-3">
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    fullWidth
                    disabled={loading || !!lockoutUntil}
                    leftIcon={
                      <svg className="h-5 w-5" viewBox="0 0 24 24">
                        <path
                          fill="#4285F4"
                          d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                        />
                        <path
                          fill="#34A853"
                          d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                        />
                        <path
                          fill="#FBBC05"
                          d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                        />
                        <path
                          fill="#EA4335"
                          d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                        />
                      </svg>
                    }
                  >
                    Google
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="md"
                    fullWidth
                    disabled={loading || !!lockoutUntil}
                    leftIcon={
                      <svg className="h-5 w-5" viewBox="0 0 24 24">
                        <path fill="#F25022" d="M1 1h10v10H1z" />
                        <path fill="#00A4EF" d="M1 13h10v10H1z" />
                        <path fill="#7FBA00" d="M13 1h10v10H13z" />
                        <path fill="#FFB900" d="M13 13h10v10H13z" />
                      </svg>
                    }
                  >
                    Microsoft
                  </Button>
                </div>

                {/* Trust indicators */}
                <div className="mt-6 border-t border-border pt-6">
                  <div className="flex items-center justify-center gap-6 text-caption text-fg-muted">
                    <div className="flex items-center gap-1.5">
                      <Shield className="h-3 w-3 text-success" />
                      <span>AES-256</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Lock className="h-3 w-3 text-primary" />
                      <span>GDPR</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Globe className="h-3 w-3 text-accent" />
                      <span>99.9% Uptime</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

        </div>

          {/* Features Bento Grid */}
          <div className="max-w-[88rem] mx-auto px-6 mb-32">
            <div className="text-center mb-12">
              <h2
                className={`text-3xl md:text-4xl font-bold mb-4 ${
                  darkMode ? 'text-white' : 'text-gray-900'
                }`}
              >
                Everything you need.{' '}
                <span className={darkMode ? 'text-gray-500' : 'text-gray-400'}>
                  Nothing you don&apos;t.
                </span>
              </h2>
              <p className={`text-lg ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                Built for teams who demand performance and privacy.
              </p>
            </div>

            <BentoGrid>
              {/* 1. Zero-Knowledge Architecture (large) — KEEP */}
              <BentoCard
                title="Zero-Knowledge Architecture"
                description="Your encryption keys never leave your device. True end-to-end encryption where even we cannot access your data."
                icon={Shield}
                size="large"
                glowColor="blue"
                darkMode={darkMode}
                gradient="bg-gradient-to-br from-blue-600/20 via-transparent to-purple-600/10"
                background={
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Lock size={200} className="text-blue-500/10" />
                  </div>
                }
              >
                <div className="grid grid-cols-2 gap-3 mt-4">
                  <div
                    className={`p-3 rounded-xl border ${
                      darkMode
                        ? 'bg-white/5 border-white/10'
                        : 'bg-blue-50 border-blue-200 shadow-sm'
                    }`}
                  >
                    <div className={`text-xl font-bold ${darkMode ? 'text-blue-400' : 'text-blue-600'}`}>
                      AES-256
                    </div>
                    <div
                      className={`text-[10px] uppercase tracking-wider ${
                        darkMode ? 'text-gray-500' : 'text-gray-600'
                      }`}
                    >
                      Encryption
                    </div>
                  </div>
                  <div
                    className={`p-3 rounded-xl border ${
                      darkMode
                        ? 'bg-white/5 border-white/10'
                        : 'bg-purple-50 border-purple-200 shadow-sm'
                    }`}
                  >
                    <div className={`text-xl font-bold ${darkMode ? 'text-purple-400' : 'text-purple-600'}`}>
                      Argon2id
                    </div>
                    <div
                      className={`text-[10px] uppercase tracking-wider ${
                        darkMode ? 'text-gray-500' : 'text-gray-600'
                      }`}
                    >
                      Key Derivation
                    </div>
                  </div>
                </div>
              </BentoCard>

              {/* 2. Video Optimization (tall) — NEW */}
              <BentoCard
                title="Video Optimization"
                description="Automatic transcoding, adaptive bitrate streaming, and thumbnail generation for all video uploads."
                icon={Video}
                size="tall"
                glowColor="purple"
                darkMode={darkMode}
                gradient="bg-gradient-to-b from-purple-600/10 to-transparent"
              >
                <div className="space-y-2.5 mt-2">
                  {[
                    { step: '1', label: 'Upload', status: 'complete' },
                    { step: '2', label: 'Detect', status: 'complete' },
                    { step: '3', label: 'Transcode', status: 'active' },
                    { step: '4', label: 'Ready', status: 'pending' },
                  ].map((item) => (
                    <div
                      key={item.step}
                      className={`flex items-center gap-3 p-2 rounded-lg border text-xs ${
                        item.status === 'complete'
                          ? darkMode
                            ? 'bg-green-500/10 border-green-500/20 text-green-400'
                            : 'bg-green-50 border-green-200 text-green-600'
                          : item.status === 'active'
                            ? darkMode
                              ? 'bg-purple-500/10 border-purple-500/20 text-purple-400'
                              : 'bg-purple-50 border-purple-200 text-purple-600'
                            : darkMode
                              ? 'bg-white/5 border-white/10 text-gray-500'
                              : 'bg-gray-50 border-gray-200 text-gray-400'
                      }`}
                    >
                      <span className="font-bold">{item.step}</span>
                      <span>{item.label}</span>
                    </div>
                  ))}
                </div>
              </BentoCard>

              {/* 3. AI Smart Tagging & OCR (wide) — NEW */}
              <BentoCard
                title="AI Smart Tagging & OCR"
                description="Automatic content tagging, object detection, and OCR text extraction from images and documents."
                icon={FileText}
                size="wide"
                glowColor="orange"
                darkMode={darkMode}
                gradient="bg-gradient-to-r from-orange-600/10 to-transparent"
              >
                <div className="mt-2">
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {['landscape', 'receipt', 'invoice', 'portrait'].map((tag) => (
                      <span
                        key={tag}
                        className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          darkMode
                            ? 'bg-orange-500/15 text-orange-400 border border-orange-500/20'
                            : 'bg-orange-50 text-orange-600 border border-orange-200'
                        }`}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div
                    className={`text-[10px] uppercase tracking-wider ${
                      darkMode ? 'text-gray-500' : 'text-gray-500'
                    }`}
                  >
                    + OCR text extraction
                  </div>
                </div>
              </BentoCard>

              {/* 4. Virus Scanning & DLP (normal) — NEW */}
              <BentoCard
                title="Virus Scanning & DLP"
                description="Real-time malware detection and data loss prevention on every upload."
                icon={ScanLine}
                glowColor="green"
                darkMode={darkMode}
              >
                <div className="space-y-2 mt-2">
                  <div className={`flex items-center justify-between text-xs ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                    <span>Malware Scan</span>
                    <span className={darkMode ? 'text-green-400' : 'text-green-600'}>Clean</span>
                  </div>
                  <div className={`flex items-center justify-between text-xs ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                    <span>DLP Check</span>
                    <span className={darkMode ? 'text-green-400' : 'text-green-600'}>No PII</span>
                  </div>
                </div>
              </BentoCard>

              {/* 5. Smart Search (normal) — UPDATED */}
              <BentoCard
                title="Smart Search"
                description="AI-powered semantic search across all your files, metadata, and OCR-extracted text."
                icon={Search}
                glowColor="purple"
                darkMode={darkMode}
              >
                <div
                  className={`mt-2 p-2 rounded-lg border ${
                    darkMode
                      ? 'bg-white/5 border-white/10'
                      : 'bg-gray-50 border-gray-200 shadow-sm'
                  }`}
                >
                  <div
                    className={`flex items-center gap-2 text-xs ${
                      darkMode ? 'text-gray-500' : 'text-gray-600'
                    }`}
                  >
                    <Search size={12} />
                    <span>Search encrypted files...</span>
                  </div>
                </div>
              </BentoCard>

              {/* 6. Lightning Fast (wide) — KEEP */}
              <BentoCard
                title="Lightning Fast"
                description="Parallel multipart uploads and smart CDN caching deliver blazing speeds."
                icon={Zap}
                size="wide"
                glowColor="cyan"
                darkMode={darkMode}
                gradient="bg-gradient-to-r from-cyan-600/10 to-transparent"
              >
                <div className="flex items-center gap-6 mt-2">
                  <div className="text-center">
                    <div className={`text-2xl font-bold ${darkMode ? 'text-cyan-400' : 'text-cyan-600'}`}>
                      40
                    </div>
                    <div
                      className={`text-[10px] uppercase ${
                        darkMode ? 'text-gray-500' : 'text-gray-600'
                      }`}
                    >
                      MB/s
                    </div>
                  </div>
                  <div className="flex-1 flex items-end gap-1 h-12">
                    {[40, 70, 50, 90, 60, 80, 95, 75, 88].map((h, i) => (
                      <div
                        key={i}
                        style={{ height: `${h}%` }}
                        className={`flex-1 bg-gradient-to-t rounded-t transition-all ${
                          darkMode
                            ? 'from-cyan-500/20 to-cyan-500/60 hover:from-cyan-500/40 hover:to-cyan-500'
                            : 'from-cyan-400/40 to-cyan-500/70 hover:from-cyan-500/60 hover:to-cyan-600'
                        }`}
                      />
                    ))}
                  </div>
                </div>
              </BentoCard>

              {/* 7. Auto Tiering (normal) — KEEP */}
              <BentoCard
                title="Auto Tiering"
                description="Cold storage for rarely accessed files. Hot storage for active ones."
                icon={Server}
                glowColor="pink"
                darkMode={darkMode}
              >
                <div className="flex gap-1 mt-2">
                  {storageTiers.map(({ tier, colorClass }) => (
                    <div
                      key={tier}
                      className={`flex-1 text-center py-1 rounded text-[10px] font-medium ${colorClass}`}
                    >
                      {tier}
                    </div>
                  ))}
                </div>
              </BentoCard>

              {/* 8. Sharing & Collaboration (normal) — SHRUNK */}
              <BentoCard
                title="Sharing & Collaboration"
                description="Generate secure share links with expiration dates and password protection. Collaborate with teams."
                icon={Share2}
                glowColor="cyan"
                darkMode={darkMode}
              >
                <div className="flex items-center gap-3 mt-2">
                  <div className="flex -space-x-2">
                    {[...Array(4)].map((_, i) => (
                      <div
                        key={i}
                        className={`w-6 h-6 rounded-full border-2 ${
                          darkMode ? 'border-gray-900' : 'border-white'
                        } ${
                          ['bg-blue-500', 'bg-purple-500', 'bg-green-500', 'bg-orange-500'][i]
                        }`}
                      />
                    ))}
                  </div>
                  <span className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>+ Team access</span>
                </div>
              </BentoCard>

              {/* 9. File Versioning (normal) — NEW */}
              <BentoCard
                title="File Versioning"
                description="Full version history with instant rollback. Never lose a previous version of your files."
                icon={History}
                glowColor="indigo"
                darkMode={darkMode}
              >
                <div className="space-y-1.5 mt-2">
                  {[
                    { version: 'v3', label: 'Current', color: darkMode ? 'text-green-400' : 'text-green-600' },
                    { version: 'v2', label: '2 days ago', color: darkMode ? 'text-gray-400' : 'text-gray-500' },
                    { version: 'v1', label: '1 week ago', color: darkMode ? 'text-gray-500' : 'text-gray-400' },
                  ].map((item) => (
                    <div key={item.version} className={`flex items-center justify-between text-xs ${item.color}`}>
                      <span className="font-medium">{item.version}</span>
                      <span>{item.label}</span>
                    </div>
                  ))}
                </div>
              </BentoCard>

              {/* 10. GDPR & Compliance (normal) — NEW */}
              <BentoCard
                title="GDPR & Compliance"
                description="Built-in compliance controls for GDPR, SOC 2, and enterprise security standards."
                icon={ShieldCheck}
                glowColor="green"
                darkMode={darkMode}
              >
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {['GDPR', 'SOC 2', 'AES-256'].map((badge) => (
                    <span
                      key={badge}
                      className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                        darkMode
                          ? 'bg-green-500/15 text-green-400 border border-green-500/20'
                          : 'bg-green-50 text-green-600 border border-green-200'
                      }`}
                    >
                      {badge}
                    </span>
                  ))}
                </div>
              </BentoCard>
            </BentoGrid>
          </div>

          {/* Performance Stats Bar */}
          <div className="max-w-[88rem] mx-auto px-6 mb-20">
            <div
              className={`relative p-8 rounded-2xl border backdrop-blur-xl overflow-hidden ${
                darkMode
                  ? 'border-white/10 bg-gradient-to-r from-gray-900/80 via-gray-900/60 to-gray-900/80'
                  : 'border-gray-200 bg-gradient-to-r from-white via-white to-blue-50/50 shadow-xl'
              }`}
            >
              <div className="absolute inset-0 bg-gradient-to-r from-blue-500/5 via-purple-500/5 to-cyan-500/5" />
              <div className="relative grid md:grid-cols-4 gap-8 text-center">
                {stats.map((stat, i) => (
                  <div key={i} ref={stat.ref} className="flex flex-col items-center">
                    <stat.icon className={`${stat.color} mb-2`} size={20} />
                    <div className={`text-2xl md:text-3xl font-bold tabular-nums ${stat.color}`}>
                      {stat.value}
                    </div>
                    <div
                      className={`text-xs uppercase tracking-wider mt-1 ${
                        darkMode ? 'text-gray-500' : 'text-gray-500'
                      }`}
                    >
                      {stat.label}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
      </main>

      {/* Footer */}
      <footer
        className={`relative py-10 ${
          darkMode ? 'bg-gray-900/80' : 'bg-white shadow-sm'
        }`}
      >
        <div className="absolute top-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-blue-500/50 to-transparent" />
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-4">
          <div
            className={`flex items-center gap-2 ${
              darkMode ? 'text-gray-300' : 'text-gray-700'
            }`}
          >
            <Cloud className="w-5 h-5" />
            <span className="text-sm font-medium">Edge Cloud Storage</span>
          </div>
          <div
            className={`flex items-center gap-6 text-sm ${
              darkMode ? 'text-gray-400' : 'text-gray-500'
            }`}
          >
            <a
              href="#"
              className={`relative transition-colors after:absolute after:left-0 after:bottom-0 after:h-px after:w-0 hover:after:w-full after:transition-all after:duration-300 ${
                darkMode ? 'hover:text-white after:bg-white' : 'hover:text-gray-900 after:bg-gray-900'
              }`}
            >
              Privacy
            </a>
            <a
              href="#"
              className={`relative transition-colors after:absolute after:left-0 after:bottom-0 after:h-px after:w-0 hover:after:w-full after:transition-all after:duration-300 ${
                darkMode ? 'hover:text-white after:bg-white' : 'hover:text-gray-900 after:bg-gray-900'
              }`}
            >
              Terms
            </a>
            <a
              href="#"
              className={`relative transition-colors after:absolute after:left-0 after:bottom-0 after:h-px after:w-0 hover:after:w-full after:transition-all after:duration-300 ${
                darkMode ? 'hover:text-white after:bg-white' : 'hover:text-gray-900 after:bg-gray-900'
              }`}
            >
              Contact
            </a>
          </div>
          <div className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            &copy; 2026 Edge Cloud Storage. All rights reserved.
          </div>
        </div>
      </footer>

      {/* Modals */}
      {showRecoverySetup && (
        <RecoveryPhraseSetup
          recoveryPhrase={recoveryPhrase}
          onConfirm={() => {
            setShowRecoverySetup(false);
            setShowRecoveryConfirm(true);
          }}
          onSkip={() => {
            setShowRecoverySetup(false);
            setRecoveryPhrase('');
            console.log('ZK Registration skipped - activating ZK mode');
            // Activate ZK mode NOW (was deferred during registration to prevent premature tree remount)
            // Navigation is handled by the useEffect that watches isAuthenticated
            localStorage.setItem(ZK_STORAGE.ZK_ENABLED_KEY, 'true');
            window.dispatchEvent(new CustomEvent('zk-mode-changed', { detail: { enabled: true } }));
          }}
        />
      )}

      {showRecoveryConfirm && (
        <RecoveryPhraseConfirm
          recoveryPhrase={recoveryPhrase}
          onConfirm={() => {
            setShowRecoveryConfirm(false);
            setRecoveryPhrase('');
            console.log('ZK Registration complete - activating ZK mode');
            // Activate ZK mode NOW (was deferred during registration to prevent premature tree remount)
            // Navigation is handled by the useEffect that watches isAuthenticated
            localStorage.setItem(ZK_STORAGE.ZK_ENABLED_KEY, 'true');
            window.dispatchEvent(new CustomEvent('zk-mode-changed', { detail: { enabled: true } }));
          }}
          onCancel={() => {
            setShowRecoveryConfirm(false);
            setShowRecoverySetup(true);
          }}
        />
      )}

      {showRecovery && (
        <RecoveryModal
          isOpen={showRecovery}
          onClose={() => { setShowRecovery(false); setForgotPasswordEmail(''); }}
          onRecoveryComplete={handleRecoveryComplete}
          initialEmail={forgotPasswordEmail}
        />
      )}

      {showForgotPassword && (
        <ForgotPasswordModal
          isOpen={showForgotPassword}
          onClose={() => setShowForgotPassword(false)}
          onSwitchToRecovery={(emailFromModal) => {
            setShowForgotPassword(false);
            setForgotPasswordEmail(emailFromModal);
            setShowRecovery(true);
          }}
          onResetComplete={() => setShowForgotPassword(false)}
        />
      )}
    </div>
  );
};

export default AuthPage;
