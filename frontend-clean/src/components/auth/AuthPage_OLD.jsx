import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sun, Moon, Cloud, Shield, Zap, Database, Lock, Upload, Download, Eye, EyeOff, ChevronRight, Check, Sparkles, Search, FileText, Copy, History, Share2, Scan, Gauge, RefreshCw, TrendingUp, Activity, Globe, Award, Info, AlertTriangle } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import { validateEmail, validatePassword, sanitizeInput, validatePasswordStrength } from '../../utils/security';
import { authService } from '../../services/authService';
import * as zkAuthService from '../../services/zkAuthService';
import RecoveryPhraseSetup from './RecoveryPhraseSetup';
import RecoveryPhraseConfirm from './RecoveryPhraseConfirm';
import RecoveryModal from './RecoveryModal';
import PasswordStrengthMeter from './PasswordStrengthMeter';

export default function AuthPage() {
  const navigate = useNavigate();
  const { darkMode, toggleTheme } = useTheme();
  const { login, register, loginZK, registerZK, setupRecoveryPhrase } = useAuth();
  const [authMode, setAuthMode] = useState('login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [enableZK, setEnableZK] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);

  // Recovery phrase flow state
  const [recoveryPhrase, setRecoveryPhrase] = useState('');
  const [showRecoverySetup, setShowRecoverySetup] = useState(false);
  const [showRecoveryConfirm, setShowRecoveryConfirm] = useState(false);

  // New state for improvements
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockoutUntil, setLockoutUntil] = useState(null);
  const [showZkTooltip, setShowZkTooltip] = useState(false);

  // Refs for focus management
  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const usernameRef = useRef(null);
  const confirmPasswordRef = useRef(null);

  const [formData, setFormData] = useState({
    email: '',
    password: '',
    confirmPassword: '',
    username: '',
    userType: 'individual'
  });

  // Password strength calculation
  const passwordStrength = formData.password ? validatePasswordStrength(formData.password) : null;

  // Lockout timer effect
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

  // Calculate remaining lockout time
  const getLockoutRemaining = useCallback(() => {
    if (!lockoutUntil) return 0;
    return Math.max(0, Math.ceil((lockoutUntil - Date.now()) / 1000));
  }, [lockoutUntil]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});

    // Check lockout
    if (lockoutUntil && Date.now() < lockoutUntil) {
      setError(`Too many failed attempts. Please wait ${getLockoutRemaining()} seconds.`);
      return;
    }

    // Validate email
    if (!validateEmail(formData.email)) {
      setFieldErrors(prev => ({ ...prev, email: 'Please enter a valid email address' }));
      emailRef.current?.focus();
      return;
    }

    // Validate password
    if (!validatePassword(formData.password)) {
      setFieldErrors(prev => ({ ...prev, password: 'Password must be at least 8 characters' }));
      passwordRef.current?.focus();
      return;
    }

    // Registration-specific validation
    if (authMode === 'register') {
      if (formData.username.length < 3) {
        setFieldErrors(prev => ({ ...prev, username: 'Username must be at least 3 characters' }));
        usernameRef.current?.focus();
        return;
      }

      // Check password strength for registration
      if (passwordStrength && !passwordStrength.isValid) {
        setFieldErrors(prev => ({ ...prev, password: 'Password does not meet strength requirements' }));
        passwordRef.current?.focus();
        return;
      }

      // Check confirm password
      if (formData.password !== formData.confirmPassword) {
        setFieldErrors(prev => ({ ...prev, confirmPassword: 'Passwords do not match' }));
        confirmPasswordRef.current?.focus();
        return;
      }
    }

    setLoading(true);

    try {
      if (authMode === 'login') {
        // Use ZK login if enabled for this email (will be determined by backend)
        // Try ZK first, fallback to standard if not ZK-enabled account
        if (enableZK) {
          await loginZK(formData.email, formData.password);
        } else {
          await login(formData.email, formData.password, rememberMe);
        }
        setFailedAttempts(0); // Reset on success
        navigate('/');
      } else {
        // Registration: use ZK if checkbox is checked
        if (enableZK) {
          await registerZK(
            formData.email,
            formData.password,
            formData.username,
            formData.userType
          );
          // For ZK registration, show recovery phrase setup
          // Pass true to skip session check since we just registered (state hasn't updated yet)
          setLoading(false);
          await handleRecoveryPhraseSetup(true);
        } else {
          await register(
            formData.email,
            formData.password,
            formData.username,
            formData.userType
          );
          navigate('/');
        }
      }
    } catch (err) {
      const errorMessage = err.message || (authMode === 'login' ? 'Invalid credentials' : 'Registration failed');
      setError(errorMessage);
      setLoading(false);

      // Handle rate limiting for login
      if (authMode === 'login') {
        const newFailedAttempts = failedAttempts + 1;
        setFailedAttempts(newFailedAttempts);

        // Lock out after 5 failed attempts for 30 seconds
        if (newFailedAttempts >= 5) {
          setLockoutUntil(Date.now() + 30000);
          setError('Too many failed attempts. Please wait 30 seconds before trying again.');
        }
      }
    }
  };

  const handleRecoveryPhraseSetup = async (skipSessionCheck = false) => {
    try {
      const result = await setupRecoveryPhrase(skipSessionCheck);
      if (result.success) {
        setRecoveryPhrase(result.recoveryPhrase);
        setShowRecoverySetup(true);
      }
    } catch (err) {
      console.error('Failed to setup recovery phrase:', err);
      // Still navigate even if recovery setup fails
      navigate('/');
    }
  };

  const handleRecoverySetupConfirm = () => {
    setShowRecoverySetup(false);
    setShowRecoveryConfirm(true);
  };

  const handleRecoverySetupSkip = () => {
    setShowRecoverySetup(false);
    setRecoveryPhrase('');
    navigate('/');
  };

  const handleRecoveryConfirmComplete = () => {
    setShowRecoveryConfirm(false);
    setRecoveryPhrase(''); // Clear from memory
    navigate('/');
  };

  const handleRecoveryConfirmCancel = () => {
    setShowRecoveryConfirm(false);
    setShowRecoverySetup(true); // Go back to setup screen
  };

  const handleRecoveryComplete = async ({ email, newPassword }) => {
    // After recovery, pre-fill the email and password
    setFormData(prev => ({
      ...prev,
      email,
      password: newPassword
    }));
    setShowRecovery(false);
    setEnableZK(true); // Enable ZK mode for login
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: sanitizeInput(value)
    }));
    // Clear field error when user starts typing
    if (fieldErrors[name]) {
      setFieldErrors(prev => ({ ...prev, [name]: null }));
    }
    // Clear general error too
    if (error) {
      setError('');
    }
  };

  // Check if email has ZK enabled (for auto-detection on login)
  const checkZKStatus = useCallback(async (email) => {
    if (!email || !validateEmail(email) || authMode !== 'login') return;

    try {
      const kdfParams = await zkAuthService.getKDFParams(email);
      if (kdfParams) {
        // Email has ZK enabled - auto-check the ZK checkbox
        setEnableZK(true);
      }
    } catch (error) {
      // User not found or ZK not enabled - that's fine
      console.log('ZK check:', error.message);
    }
  }, [authMode]);

  // Inline validation on blur
  const handleBlur = (e) => {
    const { name, value } = e.target;

    if (name === 'email' && value && !validateEmail(value)) {
      setFieldErrors(prev => ({ ...prev, email: 'Please enter a valid email address' }));
    }

    // Auto-detect ZK accounts on login
    if (name === 'email' && authMode === 'login' && value && validateEmail(value)) {
      checkZKStatus(value);
    }

    if (name === 'username' && authMode === 'register' && value && value.length < 3) {
      setFieldErrors(prev => ({ ...prev, username: 'Username must be at least 3 characters' }));
    }

    if (name === 'confirmPassword' && authMode === 'register' && value && value !== formData.password) {
      setFieldErrors(prev => ({ ...prev, confirmPassword: 'Passwords do not match' }));
    }
  };

  return (
    <div className={`min-h-screen ${darkMode ? 'dark bg-gradient-to-br from-gray-900 via-gray-800 to-gray-900' : 'bg-gradient-to-br from-blue-50 via-white to-purple-50'}`}>
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className={`absolute top-20 left-10 w-72 h-72 ${darkMode ? 'bg-blue-500' : 'bg-blue-300'} rounded-full mix-blend-multiply filter blur-xl opacity-20 animate-blob`}></div>
        <div className={`absolute top-40 right-10 w-72 h-72 ${darkMode ? 'bg-purple-500' : 'bg-purple-300'} rounded-full mix-blend-multiply filter blur-xl opacity-20 animate-blob animation-delay-2000`}></div>
        <div className={`absolute -bottom-8 left-1/2 w-72 h-72 ${darkMode ? 'bg-pink-500' : 'bg-pink-300'} rounded-full mix-blend-multiply filter blur-xl opacity-20 animate-blob animation-delay-4000`}></div>
      </div>

      {/* Header */}
      <header className={`relative z-10 ${darkMode ? 'bg-gray-900/50' : 'bg-white/50'} backdrop-blur-md border-b ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className={`p-2 rounded-xl ${darkMode ? 'bg-gradient-to-br from-blue-500 to-purple-600' : 'bg-gradient-to-br from-blue-400 to-purple-500'} shadow-lg`}>
                <Cloud className="text-white" size={28} />
              </div>
              <div>
                <h1 className={`text-xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  Edge Cloud Storage
                </h1>
                <p className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                  Enterprise-Grade Performance
                </p>
              </div>
            </div>
            <button
              onClick={toggleTheme}
              className={`p-3 rounded-xl transition-all hover:scale-110 ${darkMode ? 'bg-gray-800 text-yellow-400 hover:bg-gray-700' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}
            >
              {darkMode ? <Sun size={20} /> : <Moon size={20} />}
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="relative z-10 container mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {/* Hero Section */}
        <section className="max-w-6xl mx-auto">
          <div className="grid lg:grid-cols-2 gap-12 items-center">
            {/* Left side - Marketing */}
            <div className="space-y-8">
              <div className="inline-flex items-center gap-2 px-4 py-2 rounded-full bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/20">
                <Award className="text-blue-500" size={16} />
                <span className={`text-sm font-medium ${darkMode ? 'text-blue-300' : 'text-blue-600'}`}>
                  Production-Ready • Enterprise Features
                </span>
              </div>

              <div>
                <h2 className={`text-5xl font-bold mb-4 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  File Storage,
                  <span className="bg-gradient-to-r from-blue-500 to-purple-600 bg-clip-text text-transparent"> Reinvented</span>
                </h2>
                <p className={`text-xl ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                  Intelligent tiering, ML-powered prefetching, and parallel uploads. Built for teams who demand performance.
                </p>
              </div>

              {/* NEW: Advanced Features Highlight */}
              <div className={`p-6 rounded-2xl border-2 ${darkMode ? 'bg-gradient-to-br from-blue-900/20 to-purple-900/20 border-blue-500/30' : 'bg-gradient-to-br from-blue-50 to-purple-50 border-blue-200'}`}>
                <div className="flex items-center gap-2 mb-3">
                  <Sparkles className="text-blue-500" size={20} />
                  <h3 className={`font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                    NEW: Advanced Upload Engine
                  </h3>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <AdvancedFeatureBadge
                    icon={<Zap size={14} />}
                    text="4x Faster Uploads"
                    darkMode={darkMode}
                  />
                  <AdvancedFeatureBadge
                    icon={<RefreshCw size={14} />}
                    text="Auto-Resume"
                    darkMode={darkMode}
                  />
                  <AdvancedFeatureBadge
                    icon={<Gauge size={14} />}
                    text="Bandwidth Control"
                    darkMode={darkMode}
                  />
                  <AdvancedFeatureBadge
                    icon={<TrendingUp size={14} />}
                    text="Smart Prefetch"
                    darkMode={darkMode}
                  />
                </div>
              </div>

              {/* Key Benefits */}
              <div className="space-y-4">
                <BenefitItem
                  icon={<Zap className="text-yellow-500" size={20} />}
                  title="4x Faster Uploads"
                  description="Parallel multipart uploads with 4 concurrent chunks"
                  darkMode={darkMode}
                />
                <BenefitItem
                  icon={<Shield className="text-green-500" size={20} />}
                  title="Zero-Knowledge Security"
                  description="AES-256 encryption with client-side keys"
                  darkMode={darkMode}
                />
                <BenefitItem
                  icon={<Database className="text-blue-500" size={20} />}
                  title="50-60% Storage Savings"
                  description="Block-level deduplication across all files"
                  darkMode={darkMode}
                />
              </div>

              {/* Stats */}
              <div className={`grid grid-cols-3 gap-4 p-6 rounded-2xl ${darkMode ? 'bg-gray-800/50' : 'bg-white/50'} backdrop-blur-sm border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                <StatItem value="40 MB/s" label="Upload Speed" darkMode={darkMode} />
                <StatItem value="8TB" label="Capacity" darkMode={darkMode} />
                <StatItem value="500+" label="Concurrent Users" darkMode={darkMode} />
              </div>
            </div>

            {/* Right side - Auth Form */}
            <div>
              <div className={`p-8 rounded-2xl shadow-2xl backdrop-blur-sm border ${
                darkMode
                  ? 'bg-gray-800/80 border-gray-700'
                  : 'bg-white/80 border-gray-200'
              }`}>
                {/* Tab Switcher */}
                <div className={`flex p-1 mb-6 rounded-xl ${darkMode ? 'bg-gray-900' : 'bg-gray-100'}`}>
                  <button
                    onClick={() => setAuthMode('login')}
                    className={`flex-1 py-3 rounded-lg font-medium transition-all ${
                      authMode === 'login'
                        ? 'bg-gradient-to-r from-blue-500 to-purple-600 text-white shadow-lg'
                        : darkMode ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    Login
                  </button>
                  <button
                    onClick={() => setAuthMode('register')}
                    className={`flex-1 py-3 rounded-lg font-medium transition-all ${
                      authMode === 'register'
                        ? 'bg-gradient-to-r from-blue-500 to-purple-600 text-white shadow-lg'
                        : darkMode ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    Sign Up
                  </button>
                </div>

                {/* Lockout Warning */}
                {lockoutUntil && Date.now() < lockoutUntil && (
                  <div
                    role="alert"
                    aria-live="assertive"
                    className={`mb-6 p-4 rounded-xl flex items-center gap-3 ${
                      darkMode ? 'bg-orange-900/50 border border-orange-700' : 'bg-orange-50 border border-orange-200'
                    }`}
                  >
                    <AlertTriangle className="flex-shrink-0 text-orange-500" size={20} />
                    <p className={darkMode ? 'text-orange-200' : 'text-orange-700'}>
                      Account temporarily locked. Try again in {getLockoutRemaining()} seconds.
                    </p>
                  </div>
                )}

                {error && (
                  <div
                    role="alert"
                    aria-live="polite"
                    className={`mb-6 p-4 rounded-xl flex items-center gap-3 ${
                      darkMode ? 'bg-red-900/50 border border-red-700' : 'bg-red-50 border border-red-200'
                    }`}
                  >
                    <div className="flex-shrink-0 w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
                    <p className={darkMode ? 'text-red-200' : 'text-red-700'}>{error}</p>
                  </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                  <div>
                    <label
                      htmlFor="email"
                      className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}
                    >
                      Email Address
                    </label>
                    <input
                      ref={emailRef}
                      id="email"
                      type="email"
                      name="email"
                      placeholder="you@example.com"
                      required
                      maxLength={100}
                      value={formData.email}
                      onChange={handleInputChange}
                      onBlur={handleBlur}
                      disabled={loading || !!lockoutUntil}
                      aria-label="Email address"
                      aria-describedby={fieldErrors.email ? 'email-error' : undefined}
                      aria-invalid={!!fieldErrors.email}
                      className={`w-full px-4 py-3 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none ${
                        darkMode
                          ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                          : 'bg-gray-50 border border-gray-300 focus:bg-white'
                      } ${fieldErrors.email ? 'border-red-500 focus:ring-red-500' : ''} ${loading || lockoutUntil ? 'opacity-50 cursor-not-allowed' : ''}`}
                    />
                    {fieldErrors.email && (
                      <p id="email-error" role="alert" className="mt-1 text-sm text-red-500">
                        {fieldErrors.email}
                      </p>
                    )}
                  </div>

                  {authMode === 'register' && (
                    <div>
                      <label
                        htmlFor="username"
                        className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}
                      >
                        Username
                      </label>
                      <input
                        ref={usernameRef}
                        id="username"
                        type="text"
                        name="username"
                        placeholder="johndoe"
                        required
                        maxLength={50}
                        value={formData.username}
                        onChange={handleInputChange}
                        onBlur={handleBlur}
                        disabled={loading}
                        aria-label="Username"
                        aria-describedby={fieldErrors.username ? 'username-error' : undefined}
                        aria-invalid={!!fieldErrors.username}
                        className={`w-full px-4 py-3 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none ${
                          darkMode
                            ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                            : 'bg-gray-50 border border-gray-300 focus:bg-white'
                        } ${fieldErrors.username ? 'border-red-500 focus:ring-red-500' : ''} ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                      />
                      {fieldErrors.username && (
                        <p id="username-error" role="alert" className="mt-1 text-sm text-red-500">
                          {fieldErrors.username}
                        </p>
                      )}
                    </div>
                  )}

                  <div>
                    <label
                      htmlFor="password"
                      className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}
                    >
                      Password
                    </label>
                    <div className="relative">
                      <input
                        ref={passwordRef}
                        id="password"
                        type={showPassword ? 'text' : 'password'}
                        name="password"
                        placeholder="••••••••"
                        required
                        minLength={8}
                        value={formData.password}
                        onChange={handleInputChange}
                        disabled={loading || !!lockoutUntil}
                        aria-label="Password"
                        aria-describedby={fieldErrors.password ? 'password-error' : authMode === 'register' ? 'password-requirements' : undefined}
                        aria-invalid={!!fieldErrors.password}
                        className={`w-full px-4 py-3 pr-12 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none ${
                          darkMode
                            ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                            : 'bg-gray-50 border border-gray-300 focus:bg-white'
                        } ${fieldErrors.password ? 'border-red-500 focus:ring-red-500' : ''} ${loading || lockoutUntil ? 'opacity-50 cursor-not-allowed' : ''}`}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        disabled={loading || !!lockoutUntil}
                        className={`absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded transition-colors ${
                          darkMode ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'
                        } ${loading || lockoutUntil ? 'opacity-50 cursor-not-allowed' : ''}`}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                      >
                        {showPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                      </button>
                    </div>
                    {fieldErrors.password && (
                      <p id="password-error" role="alert" className="mt-1 text-sm text-red-500">
                        {fieldErrors.password}
                      </p>
                    )}

                    {/* Password Strength Meter (Registration only) */}
                    {authMode === 'register' && formData.password && (
                      <div id="password-requirements">
                        <PasswordStrengthMeter
                          strengthData={passwordStrength}
                          darkMode={darkMode}
                          showRequirements={true}
                        />
                      </div>
                    )}

                    {authMode === 'login' && (
                      <div className="mt-2 space-y-2">
                        {/* Remember Me and ZK Mode */}
                        <div className="flex justify-between items-center">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={rememberMe}
                              onChange={(e) => setRememberMe(e.target.checked)}
                              disabled={loading || !!lockoutUntil}
                              className="rounded border-gray-300 text-blue-500 focus:ring-blue-500"
                              aria-label="Remember me"
                            />
                            <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                              Remember me
                            </span>
                          </label>
                          <button
                            type="button"
                            onClick={() => setShowRecovery(true)}
                            disabled={loading || !!lockoutUntil}
                            className={`text-sm ${darkMode ? 'text-blue-400 hover:text-blue-300' : 'text-blue-600 hover:text-blue-700'} transition-colors`}
                          >
                            Forgot password?
                          </button>
                        </div>

                        {/* ZK Mode with Tooltip */}
                        <div className="relative">
                          <label className="flex items-center gap-2 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={enableZK}
                              onChange={(e) => setEnableZK(e.target.checked)}
                              disabled={loading || !!lockoutUntil}
                              className="rounded border-gray-300 text-blue-500 focus:ring-blue-500"
                              aria-label="Enable Zero-Knowledge Mode"
                            />
                            <span className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                              Zero-Knowledge Mode
                            </span>
                            <button
                              type="button"
                              onClick={() => setShowZkTooltip(!showZkTooltip)}
                              onBlur={() => setTimeout(() => setShowZkTooltip(false), 200)}
                              className={`p-0.5 rounded-full ${darkMode ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'}`}
                              aria-label="What is Zero-Knowledge Mode?"
                            >
                              <Info size={14} />
                            </button>
                          </label>

                          {/* ZK Tooltip */}
                          {showZkTooltip && (
                            <div className={`absolute left-0 top-full mt-2 z-50 w-72 p-3 rounded-lg shadow-lg border ${
                              darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'
                            }`}>
                              <p className={`text-xs ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                                <strong className={darkMode ? 'text-white' : 'text-gray-900'}>Zero-Knowledge Mode</strong> encrypts your files with a key only you control.
                                Even we cannot access your data. Use this for maximum privacy and security.
                              </p>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Confirm Password (Registration only) */}
                  {authMode === 'register' && (
                    <div>
                      <label
                        htmlFor="confirmPassword"
                        className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}
                      >
                        Confirm Password
                      </label>
                      <div className="relative">
                        <input
                          ref={confirmPasswordRef}
                          id="confirmPassword"
                          type={showConfirmPassword ? 'text' : 'password'}
                          name="confirmPassword"
                          placeholder="••••••••"
                          required
                          minLength={8}
                          value={formData.confirmPassword}
                          onChange={handleInputChange}
                          onBlur={handleBlur}
                          disabled={loading}
                          aria-label="Confirm password"
                          aria-describedby={fieldErrors.confirmPassword ? 'confirm-password-error' : undefined}
                          aria-invalid={!!fieldErrors.confirmPassword}
                          className={`w-full px-4 py-3 pr-12 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none ${
                            darkMode
                              ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                              : 'bg-gray-50 border border-gray-300 focus:bg-white'
                          } ${fieldErrors.confirmPassword ? 'border-red-500 focus:ring-red-500' : ''} ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                        />
                        <button
                          type="button"
                          onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                          disabled={loading}
                          className={`absolute right-3 top-1/2 -translate-y-1/2 p-1 rounded transition-colors ${
                            darkMode ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'
                          } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                          aria-label={showConfirmPassword ? 'Hide confirm password' : 'Show confirm password'}
                        >
                          {showConfirmPassword ? <EyeOff size={20} /> : <Eye size={20} />}
                        </button>
                      </div>
                      {fieldErrors.confirmPassword && (
                        <p id="confirm-password-error" role="alert" className="mt-1 text-sm text-red-500">
                          {fieldErrors.confirmPassword}
                        </p>
                      )}
                      {/* Password match indicator */}
                      {formData.confirmPassword && !fieldErrors.confirmPassword && formData.password === formData.confirmPassword && (
                        <p className="mt-1 text-sm text-green-500 flex items-center gap-1">
                          <Check size={14} /> Passwords match
                        </p>
                      )}
                    </div>
                  )}

                  {authMode === 'register' && (
                    <div className={`p-4 rounded-xl border-2 ${enableZK ? (darkMode ? 'bg-blue-900/20 border-blue-500/40' : 'bg-blue-50 border-blue-300') : (darkMode ? 'bg-gray-800/50 border-gray-700' : 'bg-gray-50 border-gray-200')}`}>
                      <label className="flex items-start gap-3 cursor-pointer group">
                        <input
                          type="checkbox"
                          checked={enableZK}
                          onChange={(e) => setEnableZK(e.target.checked)}
                          disabled={loading}
                          className="mt-1 rounded border-gray-300 text-blue-500 focus:ring-blue-500"
                          aria-label="Enable Zero-Knowledge Encryption"
                        />
                        <div className="flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Shield className={enableZK ? 'text-blue-500' : 'text-gray-400'} size={16} />
                            <span className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                              Enable Zero-Knowledge Encryption
                            </span>
                            <span className="px-2 py-0.5 text-xs font-semibold bg-gradient-to-r from-blue-500 to-purple-600 text-white rounded-full">
                              RECOMMENDED
                            </span>
                          </div>
                          <p className={`text-xs mt-1 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                            Your files are encrypted with keys only you control. We cannot access your data, even if we wanted to. {enableZK && 'You\'ll receive a 24-word recovery phrase - save it safely!'}
                          </p>
                        </div>
                      </label>
                    </div>
                  )}

                  {authMode === 'register' && (
                    <div>
                      <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                        Plan
                      </label>
                      <select
                        name="userType"
                        value={formData.userType}
                        onChange={handleInputChange}
                        disabled={loading}
                        className={`w-full px-4 py-3 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none ${
                          darkMode
                            ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                            : 'bg-gray-50 border border-gray-300 focus:bg-white'
                        } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                      >
                        <option value="individual">Individual - 100GB Free</option>
                        <option value="business">Business - 1TB ($9/mo)</option>
                        <option value="enterprise">Enterprise - 10TB ($49/mo)</option>
                      </select>
                    </div>
                  )}

                  <button
                    type="submit"
                    disabled={loading || !!lockoutUntil}
                    className={`w-full py-4 rounded-xl font-semibold text-white bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 transition-all shadow-lg hover:shadow-xl flex items-center justify-center gap-2 ${
                      loading || lockoutUntil ? 'opacity-50 cursor-not-allowed' : 'hover:scale-[1.02]'
                    }`}
                  >
                    {loading ? (
                      <>
                        <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin"></div>
                        Processing...
                      </>
                    ) : (
                      <>
                        {authMode === 'login' ? 'Sign In' : 'Create Account'}
                        <ChevronRight size={20} />
                      </>
                    )}
                  </button>
                </form>

                {/* OAuth Divider */}
                <div className="relative my-6">
                  <div className="absolute inset-0 flex items-center">
                    <div className={`w-full border-t ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}></div>
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className={`px-4 ${darkMode ? 'bg-gray-800 text-gray-400' : 'bg-white text-gray-500'}`}>
                      Or continue with
                    </span>
                  </div>
                </div>

                {/* OAuth Buttons */}
                <div className="grid grid-cols-2 gap-3">
                  {/* Google OAuth */}
                  <button
                    type="button"
                    onClick={() => authService.initiateOAuthLogin('google')}
                    disabled={loading || !!lockoutUntil}
                    className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-medium transition-all border ${
                      darkMode
                        ? 'bg-gray-900 border-gray-700 text-white hover:bg-gray-800 hover:border-gray-600'
                        : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50 hover:border-gray-400'
                    } ${loading || lockoutUntil ? 'opacity-50 cursor-not-allowed' : 'hover:scale-[1.02]'}`}
                    aria-label="Sign in with Google"
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24">
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
                    <span>Google</span>
                  </button>

                  {/* Microsoft OAuth */}
                  <button
                    type="button"
                    onClick={() => authService.initiateOAuthLogin('microsoft')}
                    disabled={loading || !!lockoutUntil}
                    className={`flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-medium transition-all border ${
                      darkMode
                        ? 'bg-gray-900 border-gray-700 text-white hover:bg-gray-800 hover:border-gray-600'
                        : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50 hover:border-gray-400'
                    } ${loading || lockoutUntil ? 'opacity-50 cursor-not-allowed' : 'hover:scale-[1.02]'}`}
                    aria-label="Sign in with Microsoft"
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24">
                      <path fill="#F25022" d="M1 1h10v10H1z" />
                      <path fill="#00A4EF" d="M1 13h10v10H1z" />
                      <path fill="#7FBA00" d="M13 1h10v10H13z" />
                      <path fill="#FFB900" d="M13 13h10v10H13z" />
                    </svg>
                    <span>Microsoft</span>
                  </button>
                </div>

                {/* Trust Indicators */}
                <div className={`mt-6 pt-6 border-t ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                  <div className="flex items-center justify-center gap-6 text-xs">
                    <div className="flex items-center gap-1">
                      <Shield size={14} className="text-green-500" />
                      <span className={darkMode ? 'text-gray-400' : 'text-gray-600'}>AES-256</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Lock size={14} className="text-blue-500" />
                      <span className={darkMode ? 'text-gray-400' : 'text-gray-600'}>GDPR Compliant</span>
                    </div>
                    <div className="flex items-center gap-1">
                      <Globe size={14} className="text-purple-500" />
                      <span className={darkMode ? 'text-gray-400' : 'text-gray-600'}>99.9% Uptime</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Performance Metrics Banner */}
        <section className="mt-16 max-w-6xl mx-auto">
          <div className={`p-8 rounded-2xl border ${darkMode ? 'bg-gradient-to-r from-gray-800 to-gray-900 border-gray-700' : 'bg-gradient-to-r from-blue-50 to-purple-50 border-blue-200'}`}>
            <div className="text-center mb-6">
              <h3 className={`text-2xl font-bold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Built for Performance at Scale
              </h3>
              <p className={`${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
                Benchmarked and optimized for 500+ concurrent users
              </p>
            </div>
            <div className="grid md:grid-cols-4 gap-6">
              <PerformanceMetric
                icon={<Zap className="text-yellow-500" size={24} />}
                before="10 MB/s"
                after="40 MB/s"
                label="Upload Speed"
                improvement="4x faster"
                darkMode={darkMode}
              />
              <PerformanceMetric
                icon={<RefreshCw className="text-blue-500" size={24} />}
                before="Lost progress"
                after="Resume anytime"
                label="Upload Reliability"
                improvement="Near-zero data loss"
                darkMode={darkMode}
              />
              <PerformanceMetric
                icon={<Activity className="text-green-500" size={24} />}
                before="5-10s"
                after="0.5-1s"
                label="Cold Storage Access"
                improvement="75% faster"
                darkMode={darkMode}
              />
              <PerformanceMetric
                icon={<Database className="text-purple-500" size={24} />}
                before="100%"
                after="40-50%"
                label="Storage Usage"
                improvement="60% savings"
                darkMode={darkMode}
              />
            </div>
          </div>
        </section>

        {/* Features Grid - UPDATED with Advanced Features */}
        <section className="mt-24 max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h3 className={`text-3xl font-bold mb-4 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Enterprise Features, Developer Experience
            </h3>
            <p className={`text-lg ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Everything you need for production workloads
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            {/* NEW Advanced Features */}
            <FeatureCard
              icon={<Zap className="text-yellow-500" size={32} />}
              title="Parallel Uploads"
              description="Upload 4 chunks simultaneously for 4x speed. Industry-leading performance."
              badge="NEW"
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<RefreshCw className="text-blue-500" size={32} />}
              title="Auto-Resume Uploads"
              description="Network interrupted? Continue exactly where you left off. Zero data loss."
              badge="NEW"
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<Gauge className="text-indigo-500" size={32} />}
              title="Bandwidth Control"
              description="Per-user bandwidth limits with token bucket algorithm for fair allocation."
              badge="NEW"
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<TrendingUp className="text-green-500" size={32} />}
              title="ML Prefetching"
              description="Predicts files you'll access next using Markov chains. 75% accuracy."
              badge="NEW"
              darkMode={darkMode}
            />

            {/* Existing Features */}
            <FeatureCard
              icon={<Database className="text-purple-500" size={32} />}
              title="Smart Deduplication"
              description="Block-level dedup saves 50-60% storage by detecting duplicate content."
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<Shield className="text-red-500" size={32} />}
              title="Zero-Knowledge Encryption"
              description="Files encrypted with your keys. We can't access your data."
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<Activity className="text-cyan-500" size={32} />}
              title="Auto-Tiering"
              description="Files automatically move between hot, warm, and cold storage tiers."
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<Eye className="text-green-500" size={32} />}
              title="Universal Preview"
              description="Preview images, PDFs, videos, documents, and code files directly."
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<Scan className="text-orange-500" size={32} />}
              title="AI-Powered OCR"
              description="Extract text from scanned documents with multi-language support."
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<Search className="text-teal-500" size={32} />}
              title="Full-Text Search"
              description="Search across files, folders, and OCR content with Elasticsearch."
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<Copy className="text-pink-500" size={32} />}
              title="Duplicate Detection"
              description="Find similar images using perceptual hashing algorithms."
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<Share2 className="text-emerald-500" size={32} />}
              title="Secure Sharing"
              description="Expiring links, password protection, and granular access controls."
              darkMode={darkMode}
            />
          </div>
        </section>

        {/* Footer */}
        <footer className={`mt-24 pt-8 border-t ${darkMode ? 'border-gray-800' : 'border-gray-200'}`}>
          <p className={`text-center text-sm ${darkMode ? 'text-gray-500' : 'text-gray-600'}`}>
            © 2025 Edge Cloud Storage. Production-ready platform with ML-powered intelligence.
          </p>
        </footer>
      </main>

      {/* Custom animations */}
      <style>{`
        @keyframes blob {
          0%, 100% { transform: translate(0px, 0px) scale(1); }
          33% { transform: translate(30px, -50px) scale(1.1); }
          66% { transform: translate(-20px, 20px) scale(0.9); }
        }
        .animate-blob {
          animation: blob 7s infinite;
        }
        .animation-delay-2000 {
          animation-delay: 2s;
        }
        .animation-delay-4000 {
          animation-delay: 4s;
        }
      `}</style>

      {/* Recovery Phrase Setup Modal */}
      {showRecoverySetup && (
        <RecoveryPhraseSetup
          recoveryPhrase={recoveryPhrase}
          onConfirm={handleRecoverySetupConfirm}
          onSkip={handleRecoverySetupSkip}
        />
      )}

      {/* Recovery Phrase Confirmation Modal */}
      {showRecoveryConfirm && (
        <RecoveryPhraseConfirm
          recoveryPhrase={recoveryPhrase}
          onConfirm={handleRecoveryConfirmComplete}
          onCancel={handleRecoveryConfirmCancel}
        />
      )}

      {/* Account Recovery Modal (Forgot Password) */}
      {showRecovery && (
        <RecoveryModal
          isOpen={showRecovery}
          onClose={() => setShowRecovery(false)}
          onRecoveryComplete={handleRecoveryComplete}
        />
      )}
    </div>
  );
}

function AdvancedFeatureBadge({ icon, text, darkMode }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg ${darkMode ? 'bg-gray-800/50' : 'bg-white/70'} border ${darkMode ? 'border-gray-700' : 'border-blue-200/50'}`}>
      <div className="text-blue-500">{icon}</div>
      <span className={`text-xs font-medium ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
        {text}
      </span>
    </div>
  );
}

function BenefitItem({ icon, title, description, darkMode }) {
  return (
    <div className="flex items-start gap-3">
      <div className={`p-2 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'} shadow-sm`}>
        {icon}
      </div>
      <div>
        <h4 className={`font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          {title}
        </h4>
        <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          {description}
        </p>
      </div>
    </div>
  );
}

function StatItem({ value, label, darkMode }) {
  return (
    <div className="text-center">
      <div className={`text-2xl font-bold bg-gradient-to-r from-blue-500 to-purple-600 bg-clip-text text-transparent`}>
        {value}
      </div>
      <div className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
        {label}
      </div>
    </div>
  );
}

function PerformanceMetric({ icon, before, after, label, improvement, darkMode }) {
  return (
    <div className="text-center space-y-2">
      <div className="flex justify-center">{icon}</div>
      <div>
        <div className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'} line-through`}>
          {before}
        </div>
        <div className={`text-xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
          {after}
        </div>
        <div className={`text-sm font-medium ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
          {label}
        </div>
        <div className="text-xs text-green-500 font-semibold mt-1">
          {improvement}
        </div>
      </div>
    </div>
  );
}

function FeatureCard({ icon, title, description, badge, darkMode }) {
  return (
    <div className={`p-6 rounded-2xl transition-all hover:scale-105 hover:shadow-xl border relative ${
      darkMode
        ? 'bg-gray-800/50 border-gray-700 hover:bg-gray-800'
        : 'bg-white border-gray-200 hover:shadow-2xl'
    }`}>
      {badge && (
        <div className="absolute top-4 right-4">
          <span className="px-2 py-1 text-xs font-bold bg-gradient-to-r from-blue-500 to-purple-600 text-white rounded-full">
            {badge}
          </span>
        </div>
      )}
      <div className={`inline-flex p-3 rounded-xl mb-4 ${darkMode ? 'bg-gray-900' : 'bg-gray-50'}`}>
        {icon}
      </div>
      <h3 className={`text-lg font-semibold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
        {title}
      </h3>
      <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
        {description}
      </p>
    </div>
  );
}
