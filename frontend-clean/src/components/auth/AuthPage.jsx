import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Sun, Moon, Cloud, Shield, Zap, Database, Lock, Upload,
  Eye, EyeOff, ChevronRight, Check, Sparkles, Search,
  Share2, Activity, Info, AlertTriangle, ArrowRight,
  Cpu, BarChart2, Globe, Server, Command, Link, Brain, Layers,
  Gauge
} from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import { validateEmail, validatePassword, sanitizeInput, validatePasswordStrength } from '../../utils/security';
import { authService } from '../../services/authService';
import * as zkAuthService from '../../services/zkAuthService';
import RecoveryPhraseSetup from './RecoveryPhraseSetup';
import RecoveryPhraseConfirm from './RecoveryPhraseConfirm';
import RecoveryModal from './RecoveryModal';
import PasswordStrengthMeter from './PasswordStrengthMeter';

// Enhanced Bento Grid Components
const BentoGrid = ({ children, className = "" }) => {
  return (
    <div className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 auto-rows-[minmax(160px,auto)] max-w-7xl mx-auto w-full ${className}`}>
      {children}
    </div>
  );
};

const BentoCard = ({
  title,
  description,
  icon: Icon,
  className = "",
  children,
  background,
  gradient,
  size = "normal",
  glowColor = "blue",
  darkMode = true
}) => {
  const sizeClasses = {
    normal: "col-span-1 row-span-1",
    large: "sm:col-span-2 lg:col-span-2 row-span-2",
    tall: "col-span-1 row-span-2",
    wide: "sm:col-span-2 lg:col-span-2 row-span-1",
  };

  const glowColors = {
    blue: darkMode ? "group-hover:shadow-blue-500/20" : "group-hover:shadow-blue-500/10",
    purple: darkMode ? "group-hover:shadow-purple-500/20" : "group-hover:shadow-purple-500/10",
    green: darkMode ? "group-hover:shadow-green-500/20" : "group-hover:shadow-green-500/10",
    cyan: darkMode ? "group-hover:shadow-cyan-500/20" : "group-hover:shadow-cyan-500/10",
    pink: darkMode ? "group-hover:shadow-pink-500/20" : "group-hover:shadow-pink-500/10",
    orange: darkMode ? "group-hover:shadow-orange-500/20" : "group-hover:shadow-orange-500/10",
    indigo: darkMode ? "group-hover:shadow-indigo-500/20" : "group-hover:shadow-indigo-500/10",
    yellow: darkMode ? "group-hover:shadow-yellow-500/20" : "group-hover:shadow-yellow-500/10",
  };

  return (
    <div className={`
      relative overflow-hidden rounded-2xl group cursor-default
      ${darkMode 
        ? 'bg-gray-900/40 border-gray-800/50 hover:border-gray-700/80' 
        : 'bg-white border-gray-200 hover:border-gray-300 shadow-sm hover:shadow-lg'}
      border transition-all duration-500
      backdrop-blur-xl ${glowColors[glowColor]}
      ${sizeClasses[size]}
      ${className}
    `}>
      {/* Gradient overlay */}
      {gradient && (
        <div className={`absolute inset-0 opacity-30 ${gradient}`} />
      )}

      {/* Custom background */}
      {background && (
        <div className="absolute inset-0 z-0 opacity-40 transition-opacity duration-500 group-hover:opacity-60">
          {background}
        </div>
      )}

      {/* Content */}
      <div className="relative z-10 p-5 h-full flex flex-col">
        <div className="flex items-center gap-3 mb-2">
          <div className={`p-2 rounded-xl border transition-colors ${
            darkMode
              ? 'bg-white/5 border-white/10 text-white/80 group-hover:text-white'
              : 'bg-gray-50 border-gray-200 text-gray-700 group-hover:text-gray-900 shadow-sm'
          }`}>
            <Icon size={18} />
          </div>
          <h3 className={`font-semibold text-sm tracking-tight ${
            darkMode ? 'text-white/90' : 'text-gray-900'
          }`}>{title}</h3>
        </div>

        <p className={`text-xs leading-relaxed mb-3 flex-shrink-0 ${
          darkMode ? 'text-gray-400' : 'text-gray-600'
        }`}>
          {description}
        </p>

        {children && <div className="mt-auto">{children}</div>}
      </div>

      {/* Hover shine effect */}
      <div className="absolute inset-0 opacity-0 group-hover:opacity-100 transition-opacity duration-700 pointer-events-none">
        <div className={`absolute inset-0 bg-gradient-to-br ${darkMode ? 'from-white/5' : 'from-white/50'} via-transparent to-transparent`} />
      </div>
    </div>
  );
};

// Floating orbs for background
const FloatingOrb = ({ className, delay = 0, darkMode = true }) => (
  <div
    className={`absolute rounded-full blur-3xl animate-float ${className} ${!darkMode ? 'opacity-30' : ''}`}
    style={{ animationDelay: `${delay}s` }}
  />
);

export default function AuthPage() {
  const navigate = useNavigate();
  const { darkMode, toggleTheme } = useTheme();
  const { login, register, loginZK, registerZK, setupRecoveryPhrase } = useAuth();

  // Auth State
  const [authMode, setAuthMode] = useState('login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [enableZK, setEnableZK] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);

  // Recovery phrase flow state
  const [recoveryPhrase, setRecoveryPhrase] = useState('');
  const [showRecoverySetup, setShowRecoverySetup] = useState(false);
  const [showRecoveryConfirm, setShowRecoveryConfirm] = useState(false);

  // Input State
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(false);
  const [fieldErrors, setFieldErrors] = useState({});
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockoutUntil, setLockoutUntil] = useState(null);
  const [showZkTooltip, setShowZkTooltip] = useState(false);

  // Refs
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

  const passwordStrength = formData.password ? validatePasswordStrength(formData.password) : null;

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

  const getLockoutRemaining = useCallback(() => {
    if (!lockoutUntil) return 0;
    return Math.max(0, Math.ceil((lockoutUntil - Date.now()) / 1000));
  }, [lockoutUntil]);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setFieldErrors({});

    if (lockoutUntil && Date.now() < lockoutUntil) {
      setError(`Too many failed attempts. Please wait ${getLockoutRemaining()} seconds.`);
      return;
    }

    if (!validateEmail(formData.email)) {
      setFieldErrors(prev => ({ ...prev, email: 'Please enter a valid email address' }));
      emailRef.current?.focus();
      return;
    }

    if (!validatePassword(formData.password)) {
      setFieldErrors(prev => ({ ...prev, password: 'Password must be at least 8 characters' }));
      passwordRef.current?.focus();
      return;
    }

    if (authMode === 'register') {
      if (formData.username.length < 3) {
        setFieldErrors(prev => ({ ...prev, username: 'Username must be at least 3 characters' }));
        usernameRef.current?.focus();
        return;
      }
      if (passwordStrength && !passwordStrength.isValid) {
        setFieldErrors(prev => ({ ...prev, password: 'Password does not meet strength requirements' }));
        passwordRef.current?.focus();
        return;
      }
      if (formData.password !== formData.confirmPassword) {
        setFieldErrors(prev => ({ ...prev, confirmPassword: 'Passwords do not match' }));
        confirmPasswordRef.current?.focus();
        return;
      }
    }

    setLoading(true);

    try {
      if (authMode === 'login') {
        if (enableZK) {
          await loginZK(formData.email, formData.password);
        } else {
          await login(formData.email, formData.password, rememberMe);
        }
        setFailedAttempts(0);
        navigate('/');
      } else {
        if (enableZK) {
          await registerZK(
            formData.email,
            formData.password,
            formData.username,
            formData.userType
          );
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

      if (authMode === 'login') {
        const newFailedAttempts = failedAttempts + 1;
        setFailedAttempts(newFailedAttempts);
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
      navigate('/');
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: sanitizeInput(value) }));
    if (fieldErrors[name]) setFieldErrors(prev => ({ ...prev, [name]: null }));
    if (error) setError('');
  };

  const checkZKStatus = useCallback(async (email) => {
    if (!email || !validateEmail(email) || authMode !== 'login') return;
    try {
      const kdfParams = await zkAuthService.getKDFParams(email);
      if (kdfParams) setEnableZK(true);
    } catch (error) {
      // Ignore
    }
  }, [authMode]);

  const handleBlur = (e) => {
    const { name, value } = e.target;
    if (name === 'email' && authMode === 'login' && value && validateEmail(value)) {
      checkZKStatus(value);
    }
  };

  return (
    <div className={`min-h-screen font-sans selection:bg-blue-500/30 overflow-hidden transition-colors duration-300 ${
      darkMode ? 'bg-black text-white' : 'bg-gradient-to-br from-gray-50 via-white to-blue-50/30 text-gray-900'
    }`}>
      {/* Animated Background */}
      <div className="fixed inset-0 -z-10">
        {/* Grid pattern */}
        <div className={`absolute inset-0 bg-[size:64px_64px] ${
          darkMode
            ? 'bg-[linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)]'
            : 'bg-[linear-gradient(rgba(59,130,246,0.03)_1px,transparent_1px),linear-gradient(90deg,rgba(59,130,246,0.03)_1px,transparent_1px)]'
        }`} />

        {/* Floating orbs - enhanced for light mode */}
        <FloatingOrb className={`w-[600px] h-[600px] top-[-200px] left-[-200px] ${darkMode ? 'bg-blue-600/20' : 'bg-blue-400/15'}`} delay={0} darkMode={darkMode} />
        <FloatingOrb className={`w-[500px] h-[500px] top-[40%] right-[-150px] ${darkMode ? 'bg-purple-600/15' : 'bg-purple-400/12'}`} delay={2} darkMode={darkMode} />
        <FloatingOrb className={`w-[400px] h-[400px] bottom-[-100px] left-[30%] ${darkMode ? 'bg-cyan-600/10' : 'bg-cyan-400/10'}`} delay={4} darkMode={darkMode} />

        {/* Radial gradient overlay */}
        <div className={`absolute inset-0 ${
          darkMode
            ? 'bg-[radial-gradient(ellipse_at_center,transparent_0%,black_70%)]'
            : 'bg-[radial-gradient(ellipse_at_center,rgba(255,255,255,0.8)_0%,rgba(249,250,251,0.95)_70%)]'
        }`} />
      </div>

      {/* Navbar */}
      <nav className={`fixed top-0 w-full z-50 border-b backdrop-blur-xl transition-colors ${
        darkMode 
          ? 'border-white/5 bg-black/40' 
          : 'border-gray-200/80 bg-white/80 shadow-sm'
      }`}>
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="relative">
              <div className={`absolute inset-0 bg-gradient-to-br from-blue-500 to-purple-600 rounded-xl blur-lg ${
                darkMode ? 'opacity-50' : 'opacity-40'
              }`} />
              <div className="relative bg-gradient-to-br from-blue-500 to-purple-600 p-2.5 rounded-xl shadow-lg">
                <Cloud className="text-white w-5 h-5" />
              </div>
            </div>
            <span className={`font-bold text-lg tracking-tight ${darkMode ? 'text-white' : 'text-gray-900'}`}>Edge Cloud</span>
          </div>
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
      </nav>

      <main className="pt-28 pb-20 px-6">
        <div className="max-w-7xl mx-auto">
          {/* Hero Section */}
          <div className="grid lg:grid-cols-2 gap-16 items-center mb-32">
            {/* Hero Left */}
            <div className="relative z-10">
              {/* Badge */}
              <div className={`inline-flex items-center gap-2 px-4 py-2 rounded-full border mb-8 ${
                darkMode
                  ? 'bg-gradient-to-r from-blue-500/10 to-purple-500/10 border-blue-500/20'
                  : 'bg-gradient-to-r from-blue-50 to-purple-50 border-blue-200 shadow-sm'
              }`}>
                <div className="relative flex h-2 w-2">
                  <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${
                    darkMode ? 'bg-blue-400' : 'bg-blue-500'
                  }`}></span>
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${
                    darkMode ? 'bg-blue-500' : 'bg-blue-600'
                  }`}></span>
                </div>
                <span className={`text-sm font-medium ${
                  darkMode ? 'text-blue-400' : 'text-blue-600'
                }`}>Zero-Knowledge Encryption</span>
              </div>

              {/* Main heading */}
              <h1 className="text-5xl md:text-6xl lg:text-7xl font-bold tracking-tight leading-[1.1] mb-8">
                File Storage,{' '}
                <span className="relative">
                  <span className="text-transparent bg-clip-text bg-gradient-to-r from-blue-400 via-purple-400 to-cyan-400">
                    Reinvented.
                  </span>
                  <span className="absolute -inset-1 bg-gradient-to-r from-blue-500/20 via-purple-500/20 to-cyan-500/20 blur-2xl -z-10" />
                </span>
              </h1>

              {/* Subtitle */}
              <p className={`text-lg md:text-xl leading-relaxed mb-10 max-w-lg ${
                darkMode ? 'text-gray-400' : 'text-gray-700'
              }`}>
                Enterprise-grade security with consumer-level simplicity.
                Your data, encrypted with keys{' '}
                <span className={`font-semibold ${
                  darkMode ? 'text-white' : 'text-gray-900'
                }`}>only you hold</span>.
              </p>

              {/* Feature pills */}
              <div className="flex flex-wrap gap-3">
                {[
                  { icon: Shield, label: 'AES-256 GCM', color: darkMode ? 'text-green-500' : 'text-green-600' },
                  { icon: Brain, label: 'ML-Powered', color: darkMode ? 'text-purple-500' : 'text-purple-600' },
                  { icon: Layers, label: 'Auto-Tiering', color: darkMode ? 'text-blue-500' : 'text-blue-600' },
                ].map((item, i) => (
                  <div
                    key={i}
                    className={`flex items-center gap-2 px-4 py-2 rounded-full border transition-all ${
                      darkMode
                        ? 'bg-white/5 border-white/10 hover:border-white/20'
                        : 'bg-white border-gray-200 hover:border-blue-200 hover:shadow-md shadow-sm'
                    }`}
                  >
                    <item.icon className={item.color} size={14} />
                    <span className={`text-sm font-medium ${
                      darkMode ? 'text-gray-300' : 'text-gray-700'
                    }`}>{item.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Auth Card Right */}
            <div className="relative">
              {/* Glow effect behind card */}
              <div className={`absolute -inset-4 bg-gradient-to-r from-blue-500/20 via-purple-500/20 to-cyan-500/20 rounded-3xl blur-3xl ${
                darkMode ? 'opacity-50' : 'opacity-20'
              }`} />

              <div className={`relative p-8 rounded-2xl border backdrop-blur-2xl ${
                darkMode
                  ? 'border-white/10 bg-gray-900/80 shadow-2xl'
                  : 'border-gray-200/80 bg-white/95 shadow-2xl shadow-gray-200/50'
              }`}>
                {/* Tab Switcher */}
                <div className={`mb-8 flex p-1 rounded-xl ${
                  darkMode 
                    ? 'bg-white/5 border border-white/5' 
                    : 'bg-gray-100 border border-gray-200 shadow-inner'
                }`}>
                  <button
                    onClick={() => setAuthMode('login')}
                    className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all duration-300 ${
                      authMode === 'login'
                        ? darkMode 
                          ? 'bg-white/10 text-white shadow-lg' 
                          : 'bg-white text-gray-900 shadow-md border border-gray-200'
                        : darkMode 
                          ? 'text-gray-400 hover:text-gray-200' 
                          : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    Log In
                  </button>
                  <button
                    onClick={() => setAuthMode('register')}
                    className={`flex-1 py-2.5 rounded-lg text-sm font-semibold transition-all duration-300 ${
                      authMode === 'register'
                        ? darkMode 
                          ? 'bg-white/10 text-white shadow-lg' 
                          : 'bg-white text-gray-900 shadow-md border border-gray-200'
                        : darkMode 
                          ? 'text-gray-400 hover:text-gray-200' 
                          : 'text-gray-600 hover:text-gray-900'
                    }`}
                  >
                    Sign Up
                  </button>
                </div>

                <form onSubmit={handleSubmit} className="space-y-5">
                  {/* Email */}
                  <div>
                    <label className={`block text-xs font-medium uppercase tracking-wider mb-2 ml-1 ${
                      darkMode ? 'text-gray-400' : 'text-gray-500'
                    }`}>
                      Email
                    </label>
                    <input
                      ref={emailRef}
                      type="email"
                      name="email"
                      value={formData.email}
                      onChange={handleInputChange}
                      onBlur={handleBlur}
                      className={`w-full rounded-xl px-4 py-3.5 outline-none transition-all ${
                        darkMode
                          ? 'bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:border-blue-500/50 focus:ring-2 focus:ring-blue-500/20'
                          : 'bg-white border border-gray-300 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 shadow-sm hover:border-gray-400'
                      } ${fieldErrors.email ? 'border-red-500/50' : ''}`}
                      placeholder="name@company.com"
                    />
                    {fieldErrors.email && <p className="text-red-400 text-xs mt-1 ml-1">{fieldErrors.email}</p>}
                  </div>

                  {/* Username (register only) */}
                  {authMode === 'register' && (
                    <div>
                      <label className={`block text-xs font-medium uppercase tracking-wider mb-2 ml-1 ${
                        darkMode ? 'text-gray-400' : 'text-gray-500'
                      }`}>
                        Username
                      </label>
                      <input
                        ref={usernameRef}
                        type="text"
                        name="username"
                        value={formData.username}
                        onChange={handleInputChange}
                        className={`w-full rounded-xl px-4 py-3.5 outline-none transition-all ${
                          darkMode
                            ? 'bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:border-blue-500/50 focus:ring-2 focus:ring-blue-500/20'
                            : 'bg-white border border-gray-300 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 shadow-sm hover:border-gray-400'
                        } ${fieldErrors.username ? 'border-red-500/50' : ''}`}
                        placeholder="username"
                      />
                      {fieldErrors.username && <p className="text-red-400 text-xs mt-1 ml-1">{fieldErrors.username}</p>}
                    </div>
                  )}

                  {/* Password */}
                  <div>
                    <label className={`block text-xs font-medium uppercase tracking-wider mb-2 ml-1 ${
                      darkMode ? 'text-gray-400' : 'text-gray-500'
                    }`}>
                      Password
                    </label>
                    <div className="relative">
                      <input
                        ref={passwordRef}
                        type={showPassword ? 'text' : 'password'}
                        name="password"
                        value={formData.password}
                        onChange={handleInputChange}
                        className={`w-full rounded-xl px-4 py-3.5 pr-12 outline-none transition-all ${
                          darkMode
                            ? 'bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:border-blue-500/50 focus:ring-2 focus:ring-blue-500/20'
                            : 'bg-white border border-gray-300 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 shadow-sm hover:border-gray-400'
                        } ${fieldErrors.password ? 'border-red-500/50' : ''}`}
                        placeholder="••••••••"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className={`absolute right-3 top-1/2 -translate-y-1/2 transition-colors ${
                          darkMode ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'
                        }`}
                      >
                        {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                      </button>
                    </div>
                    {fieldErrors.password && <p className="text-red-400 text-xs mt-1 ml-1">{fieldErrors.password}</p>}

                    {authMode === 'register' && formData.password && (
                      <div className="mt-2">
                        <PasswordStrengthMeter strengthData={passwordStrength} darkMode={darkMode} showRequirements={false} />
                      </div>
                    )}
                  </div>

                  {/* Confirm Password (register only) */}
                  {authMode === 'register' && (
                    <div>
                      <label className={`block text-xs font-medium uppercase tracking-wider mb-2 ml-1 ${
                        darkMode ? 'text-gray-400' : 'text-gray-500'
                      }`}>
                        Confirm Password
                      </label>
                      <div className="relative">
                        <input
                          ref={confirmPasswordRef}
                          type={showConfirmPassword ? 'text' : 'password'}
                          name="confirmPassword"
                          value={formData.confirmPassword}
                          onChange={handleInputChange}
                          className={`w-full rounded-xl px-4 py-3.5 pr-12 outline-none transition-all ${
                            darkMode
                              ? 'bg-white/5 border border-white/10 text-white placeholder-gray-500 focus:border-blue-500/50 focus:ring-2 focus:ring-blue-500/20'
                              : 'bg-white border border-gray-300 text-gray-900 placeholder-gray-400 focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 shadow-sm hover:border-gray-400'
                          } ${fieldErrors.confirmPassword ? 'border-red-500/50' : ''}`}
                          placeholder="••••••••"
                        />
                        <button
                          type="button"
                          onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                          className={`absolute right-3 top-1/2 -translate-y-1/2 transition-colors ${
                            darkMode ? 'text-gray-500 hover:text-gray-300' : 'text-gray-400 hover:text-gray-600'
                          }`}
                        >
                          {showConfirmPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                        </button>
                      </div>
                      {fieldErrors.confirmPassword && <p className="text-red-400 text-xs mt-1 ml-1">{fieldErrors.confirmPassword}</p>}
                    </div>
                  )}

                  {/* ZK Toggle */}
                  <div className={`p-4 rounded-xl border transition-all ${
                    enableZK
                      ? darkMode
                        ? 'bg-blue-500/10 border-blue-500/30'
                        : 'bg-blue-50 border-blue-200 shadow-sm'
                      : darkMode
                        ? 'bg-white/5 border-white/10 hover:border-white/20'
                        : 'bg-gray-50 border-gray-200 hover:border-blue-200 hover:shadow-sm'
                  }`}>
                    <label className="flex items-start gap-3 cursor-pointer">
                      <div className="relative flex items-center mt-0.5">
                        <input
                          type="checkbox"
                          checked={enableZK}
                          onChange={(e) => setEnableZK(e.target.checked)}
                          className={`w-5 h-5 rounded text-blue-500 focus:ring-blue-500/50 focus:ring-offset-0 ${
                            darkMode ? 'border-gray-600 bg-white/5' : 'border-gray-300 bg-white'
                          }`}
                        />
                      </div>
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <Shield size={16} className={enableZK ? (darkMode ? 'text-blue-400' : 'text-blue-600') : 'text-gray-400'} />
                          <span className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                            Zero-Knowledge Encryption
                          </span>
                          {authMode === 'register' && (
                            <span className="px-2 py-0.5 text-[10px] font-bold bg-gradient-to-r from-blue-500 to-purple-500 text-white rounded-full uppercase shadow-sm">
                              Recommended
                            </span>
                          )}
                        </div>
                        <p className={`text-xs leading-relaxed ${
                          darkMode ? 'text-gray-400' : 'text-gray-600'
                        }`}>
                          Client-side encryption. We can't see your data.
                        </p>
                      </div>
                    </label>
                  </div>

                  {/* Error */}
                  {error && (
                    <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl flex items-center gap-3 text-red-400 text-sm">
                      <AlertTriangle size={16} className="flex-shrink-0" />
                      {error}
                    </div>
                  )}

                  {/* Submit Button */}
                  <button
                    type="submit"
                    disabled={loading || !!lockoutUntil}
                    className={`w-full relative group bg-gradient-to-r from-blue-600 to-purple-600 hover:from-blue-500 hover:to-purple-500 text-white font-semibold py-3.5 rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 overflow-hidden ${
                      !darkMode ? 'shadow-lg shadow-blue-500/30 hover:shadow-xl hover:shadow-blue-500/40' : ''
                    }`}
                  >
                    <span className="absolute inset-0 bg-gradient-to-r from-blue-400 to-purple-400 opacity-0 group-hover:opacity-20 transition-opacity" />
                    {loading ? (
                      <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    ) : (
                      <>
                        {authMode === 'login' ? 'Continue' : 'Create Account'}
                        <ArrowRight size={18} className="group-hover:translate-x-1 transition-transform" />
                      </>
                    )}
                  </button>
                </form>

                {/* Forgot Password */}
                {authMode === 'login' && (
                  <div className="mt-6 text-center">
                    <button
                      onClick={() => setShowRecovery(true)}
                      className={`text-sm transition-colors ${
                        darkMode ? 'text-gray-500 hover:text-gray-300' : 'text-gray-500 hover:text-gray-700'
                      }`}
                    >
                      Forgot your password?
                    </button>
                  </div>
                )}

                {/* OAuth Divider */}
                <div className="relative my-6">
                  <div className="absolute inset-0 flex items-center">
                    <div className={`w-full border-t ${darkMode ? 'border-gray-700' : 'border-gray-300'}`}></div>
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className={`px-4 ${darkMode ? 'bg-gray-900 text-gray-400' : 'bg-white text-gray-500'}`}>
                      Or continue with
                    </span>
                  </div>
                </div>

                {/* OAuth Buttons */}
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    disabled={loading || !!lockoutUntil}
                    className={`flex items-center justify-center gap-2.5 px-4 py-3 rounded-xl font-medium transition-all border ${
                      darkMode
                        ? 'bg-gray-800 border-gray-700 text-white hover:bg-gray-700 hover:border-gray-600'
                        : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50 hover:border-gray-400 shadow-sm hover:shadow-md'
                    } ${loading || lockoutUntil ? 'opacity-50 cursor-not-allowed' : 'hover:scale-[1.02]'}`}
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    <span>Google</span>
                  </button>
                  <button
                    type="button"
                    disabled={loading || !!lockoutUntil}
                    className={`flex items-center justify-center gap-2.5 px-4 py-3 rounded-xl font-medium transition-all border ${
                      darkMode
                        ? 'bg-gray-800 border-gray-700 text-white hover:bg-gray-700 hover:border-gray-600'
                        : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50 hover:border-gray-400 shadow-sm hover:shadow-md'
                    } ${loading || lockoutUntil ? 'opacity-50 cursor-not-allowed' : 'hover:scale-[1.02]'}`}
                  >
                    <svg className="w-5 h-5" viewBox="0 0 24 24">
                      <path fill="#F25022" d="M1 1h10v10H1z"/>
                      <path fill="#00A4EF" d="M1 13h10v10H1z"/>
                      <path fill="#7FBA00" d="M13 1h10v10H13z"/>
                      <path fill="#FFB900" d="M13 13h10v10H13z"/>
                    </svg>
                    <span>Microsoft</span>
                  </button>
                </div>

                {/* Trust indicators */}
                <div className={`mt-6 pt-6 border-t ${darkMode ? 'border-white/5' : 'border-gray-100'}`}>
                  <div className={`flex items-center justify-center gap-6 text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
                    <div className="flex items-center gap-1.5">
                      <Shield size={12} className="text-green-500" />
                      <span>AES-256</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Lock size={12} className="text-blue-500" />
                      <span>GDPR</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <Globe size={12} className="text-purple-500" />
                      <span>99.9% Uptime</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Features Bento Grid */}
          <div className="mb-32">
            <div className="text-center mb-12">
              <h2 className={`text-3xl md:text-4xl font-bold mb-4 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Everything you need.{' '}
                <span className={darkMode ? 'text-gray-500' : 'text-gray-400'}>Nothing you don't.</span>
              </h2>
              <p className={`text-lg ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>Built for teams who demand performance and privacy.</p>
            </div>

            <BentoGrid>
              {/* Large ZK Card */}
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
                  <div className={`p-3 rounded-xl border ${
                    darkMode 
                      ? 'bg-white/5 border-white/10' 
                      : 'bg-blue-50 border-blue-200 shadow-sm'
                  }`}>
                    <div className={`text-xl font-bold ${
                      darkMode ? 'text-blue-400' : 'text-blue-600'
                    }`}>AES-256</div>
                    <div className={`text-[10px] uppercase tracking-wider ${
                      darkMode ? 'text-gray-500' : 'text-gray-600'
                    }`}>Encryption</div>
                  </div>
                  <div className={`p-3 rounded-xl border ${
                    darkMode 
                      ? 'bg-white/5 border-white/10' 
                      : 'bg-purple-50 border-purple-200 shadow-sm'
                  }`}>
                    <div className={`text-xl font-bold ${
                      darkMode ? 'text-purple-400' : 'text-purple-600'
                    }`}>Argon2id</div>
                    <div className={`text-[10px] uppercase tracking-wider ${
                      darkMode ? 'text-gray-500' : 'text-gray-600'
                    }`}>Key Derivation</div>
                  </div>
                </div>
              </BentoCard>

              {/* AI Analytics - Tall */}
              <BentoCard
                title="AI Analytics"
                description="Predictive storage quotas and smart file organization powered by local ML models."
                icon={Sparkles}
                size="tall"
                glowColor="purple"
                darkMode={darkMode}
                gradient="bg-gradient-to-b from-purple-600/10 to-transparent"
              >
                <div className="space-y-3 mt-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className={darkMode ? 'text-gray-500' : 'text-gray-600'}>Quota Prediction</span>
                    <span className={darkMode ? 'text-green-400' : 'text-green-600'} style={{ fontFamily: 'monospace' }}>98% Acc</span>
                  </div>
                  <div className={`h-1.5 w-full rounded-full overflow-hidden ${
                    darkMode ? 'bg-white/10' : 'bg-gray-200'
                  }`}>
                    <div className="h-full bg-gradient-to-r from-green-400 to-blue-500 w-[85%]" />
                  </div>
                  <div className={`p-2.5 rounded-lg border text-[11px] ${
                    darkMode
                      ? 'bg-white/5 border-white/10 text-gray-400'
                      : 'bg-purple-50 border-purple-200 text-gray-600 shadow-sm'
                  }`}>
                    "Your storage usage is trending up. Consider archiving 'Old Projects'."
                  </div>
                </div>
              </BentoCard>

              {/* Deduplication */}
              <BentoCard
                title="Deduplication"
                description="Block-level dedup saves up to 60% storage automatically."
                icon={Database}
                glowColor="green"
                darkMode={darkMode}
              >
                <div className="flex items-center gap-2 mt-2">
                  <div className={`text-lg font-bold ${
                    darkMode ? 'text-green-400' : 'text-green-600'
                  }`}>60%</div>
                  <div className={`text-[10px] ${
                    darkMode ? 'text-gray-500' : 'text-gray-600'
                  }`}>avg. savings</div>
                </div>
              </BentoCard>

              {/* URL Upload */}
              <BentoCard
                title="URL Upload"
                description="Import files directly from any URL. No download required."
                icon={Link}
                glowColor="orange"
                darkMode={darkMode}
              />

              {/* Performance - Wide */}
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
                    <div className={`text-2xl font-bold ${
                      darkMode ? 'text-cyan-400' : 'text-cyan-600'
                    }`}>40</div>
                    <div className={`text-[10px] uppercase ${
                      darkMode ? 'text-gray-500' : 'text-gray-600'
                    }`}>MB/s</div>
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

              {/* Auto Tiering */}
              <BentoCard
                title="Auto Tiering"
                description="Cold storage for rarely accessed files. Hot storage for active ones."
                icon={Server}
                glowColor="pink"
                darkMode={darkMode}
              >
                <div className="flex gap-1 mt-2">
                  {['Hot', 'Warm', 'Cold'].map((tier, i) => (
                    <div key={tier} className={`flex-1 text-center py-1 rounded text-[10px] font-medium ${
                      i === 0 
                        ? darkMode 
                          ? 'bg-red-500/20 text-red-400' 
                          : 'bg-red-50 text-red-600 border border-red-200'
                        : i === 1 
                          ? darkMode 
                            ? 'bg-yellow-500/20 text-yellow-400' 
                            : 'bg-yellow-50 text-yellow-600 border border-yellow-200'
                          : darkMode 
                            ? 'bg-blue-500/20 text-blue-400' 
                            : 'bg-blue-50 text-blue-600 border border-blue-200'
                    }`}>
                      {tier}
                    </div>
                  ))}
                </div>
              </BentoCard>

              {/* Sharing & Collaboration */}
              <BentoCard
                title="Sharing & Collaboration"
                description="Generate secure share links with expiration dates and password protection. Collaborate with teams."
                icon={Share2}
                size="wide"
                glowColor="cyan"
                darkMode={darkMode}
                gradient="bg-gradient-to-r from-cyan-600/10 to-blue-600/10"
              >
                <div className="flex items-center gap-3 mt-2">
                  <div className="flex -space-x-2">
                    {[...Array(4)].map((_, i) => (
                      <div key={i} className={`w-6 h-6 rounded-full border-2 border-gray-900 ${
                        ['bg-blue-500', 'bg-purple-500', 'bg-green-500', 'bg-orange-500'][i]
                      }`} />
                    ))}
                  </div>
                  <span className="text-xs text-gray-400">+ Team access</span>
                </div>
              </BentoCard>

              {/* Smart Search */}
              <BentoCard
                title="Smart Search"
                description="AI-powered semantic search across all your files and metadata."
                icon={Search}
                glowColor="purple"
                darkMode={darkMode}
              >
                <div className={`mt-2 p-2 rounded-lg border ${
                  darkMode 
                    ? 'bg-white/5 border-white/10' 
                    : 'bg-gray-50 border-gray-200 shadow-sm'
                }`}>
                  <div className={`flex items-center gap-2 text-xs ${
                    darkMode ? 'text-gray-500' : 'text-gray-600'
                  }`}>
                    <Search size={12} />
                    <span>Search encrypted files...</span>
                  </div>
                </div>
              </BentoCard>

              {/* Universal Preview */}
              <BentoCard
                title="Universal Preview"
                description="Preview images, PDFs, videos, documents, and code files directly."
                icon={Eye}
                glowColor="green"
                darkMode={darkMode}
              >
                <div className="flex flex-wrap gap-1.5 mt-2">
                  {['PDF', 'IMG', 'VID', 'CODE'].map((type) => (
                    <div key={type} className={`px-2 py-0.5 rounded text-[10px] font-medium ${
                      darkMode 
                        ? 'bg-white/5 border border-white/10 text-gray-400' 
                        : 'bg-gray-100 border border-gray-200 text-gray-600'
                    }`}>
                      {type}
                    </div>
                  ))}
                </div>
              </BentoCard>

              {/* Resumable Uploads */}
              <BentoCard
                title="Resumable Uploads"
                description="Network interruption? No problem. Resume uploads exactly where you left off."
                icon={Upload}
                glowColor="green"
                darkMode={darkMode}
              >
                <div className="mt-2 space-y-1">
                  <div className="flex items-center justify-between text-xs">
                    <span className={darkMode ? 'text-gray-500' : 'text-gray-600'}>project.zip</span>
                    <span className={darkMode ? 'text-green-400' : 'text-green-600'}>75%</span>
                  </div>
                  <div className={`h-1.5 w-full rounded-full overflow-hidden ${
                    darkMode ? 'bg-white/10' : 'bg-gray-200'
                  }`}>
                    <div className="h-full bg-gradient-to-r from-green-400 to-emerald-500 w-[75%]" />
                  </div>
                </div>
              </BentoCard>

              {/* Bandwidth Control */}
              <BentoCard
                title="Bandwidth Control"
                description="Per-user bandwidth limits with token bucket algorithm for fair allocation."
                icon={Gauge}
                glowColor="indigo"
                darkMode={darkMode}
              >
                <div className="mt-2 space-y-1">
                  <div className={`h-1.5 w-full rounded-full overflow-hidden ${
                    darkMode ? 'bg-white/10' : 'bg-gray-200'
                  }`}>
                    <div className="h-full bg-gradient-to-r from-indigo-400 to-purple-500 w-[65%]" />
                  </div>
                  <div className={`text-[10px] ${
                    darkMode ? 'text-gray-500' : 'text-gray-600'
                  }`}>65% allocated</div>
                </div>
              </BentoCard>

              {/* End-to-End Encrypted */}
              <BentoCard
                title="End-to-End Encrypted"
                description="Your data is encrypted before it leaves your device. Keys never touch our servers."
                icon={Lock}
                size="tall"
                glowColor="green"
                darkMode={darkMode}
                gradient="bg-gradient-to-b from-green-600/10 to-transparent"
              >
                <div className="space-y-3 mt-4">
                  <div className={`p-3 rounded-lg border ${
                    darkMode 
                      ? 'bg-green-500/10 border-green-500/20' 
                      : 'bg-green-50 border-green-200 shadow-sm'
                  }`}>
                    <div className={`flex items-center gap-2 text-xs ${
                      darkMode ? 'text-green-400' : 'text-green-600'
                    }`}>
                      <Lock size={12} />
                      <span>Client-side encryption</span>
                    </div>
                  </div>
                  <div className={`p-3 rounded-lg border ${
                    darkMode 
                      ? 'bg-blue-500/10 border-blue-500/20' 
                      : 'bg-blue-50 border-blue-200 shadow-sm'
                  }`}>
                    <div className={`flex items-center gap-2 text-xs ${
                      darkMode ? 'text-blue-400' : 'text-blue-600'
                    }`}>
                      <Shield size={12} />
                      <span>Zero-knowledge proof</span>
                    </div>
                  </div>
                  <div className={`p-3 rounded-lg border ${
                    darkMode 
                      ? 'bg-purple-500/10 border-purple-500/20' 
                      : 'bg-purple-50 border-purple-200 shadow-sm'
                  }`}>
                    <div className={`flex items-center gap-2 text-xs ${
                      darkMode ? 'text-purple-400' : 'text-purple-600'
                    }`}>
                      <Eye size={12} />
                      <span>Only you can decrypt</span>
                    </div>
                  </div>
                </div>
              </BentoCard>
            </BentoGrid>
          </div>

          {/* Performance Stats Bar */}
          <div className="mb-20">
            <div className={`relative p-8 rounded-2xl border backdrop-blur-xl overflow-hidden ${
              darkMode
                ? 'border-white/10 bg-gradient-to-r from-gray-900/80 via-gray-900/60 to-gray-900/80'
                : 'border-gray-200 bg-gradient-to-r from-white via-white to-blue-50/50 shadow-xl'
            }`}>
              <div className="absolute inset-0 bg-gradient-to-r from-blue-500/5 via-purple-500/5 to-cyan-500/5" />
              <div className="relative grid md:grid-cols-4 gap-8 text-center">
                {[
                  { value: '40 MB/s', label: 'Upload Speed', icon: Zap, color: 'text-yellow-500' },
                  { value: '8 TB', label: 'Max Capacity', icon: Database, color: 'text-blue-500' },
                  { value: '500+', label: 'Concurrent Users', icon: Activity, color: 'text-green-500' },
                  { value: '60%', label: 'Storage Savings', icon: Layers, color: 'text-purple-500' },
                ].map((stat, i) => (
                  <div key={i} className="flex flex-col items-center">
                    <stat.icon className={`${stat.color} mb-2`} size={20} />
                    <div className={`text-2xl md:text-3xl font-bold ${stat.color}`}>{stat.value}</div>
                    <div className={`text-xs uppercase tracking-wider mt-1 ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>{stat.label}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className={`border-t py-10 ${
        darkMode
          ? 'border-white/10 bg-gray-900/80'
          : 'border-gray-200 bg-white shadow-sm'
      }`}>
        <div className="max-w-7xl mx-auto px-6 flex flex-col md:flex-row justify-between items-center gap-4">
          <div className={`flex items-center gap-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
            <Cloud className="w-5 h-5" />
            <span className="text-sm font-medium">Edge Cloud Storage</span>
          </div>
          <div className={`flex items-center gap-6 text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            <a href="#" className={`transition-colors ${darkMode ? 'hover:text-white' : 'hover:text-gray-900'}`}>Privacy</a>
            <a href="#" className={`transition-colors ${darkMode ? 'hover:text-white' : 'hover:text-gray-900'}`}>Terms</a>
            <a href="#" className={`transition-colors ${darkMode ? 'hover:text-white' : 'hover:text-gray-900'}`}>Contact</a>
          </div>
          <div className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-500'}`}>
            © 2025 Edge Cloud Storage. All rights reserved.
          </div>
        </div>
      </footer>

      {/* Floating animation keyframes */}
      <style>{`
        @keyframes float {
          0%, 100% { transform: translate(0, 0) scale(1); }
          33% { transform: translate(30px, -30px) scale(1.05); }
          66% { transform: translate(-20px, 20px) scale(0.95); }
        }
        .animate-float {
          animation: float 20s ease-in-out infinite;
        }
      `}</style>

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
            navigate('/');
          }}
        />
      )}

      {showRecoveryConfirm && (
        <RecoveryPhraseConfirm
          recoveryPhrase={recoveryPhrase}
          onConfirm={() => {
            setShowRecoveryConfirm(false);
            setRecoveryPhrase('');
            navigate('/');
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
          onClose={() => setShowRecovery(false)}
          onRecoveryComplete={({ email, newPassword }) => {
            setFormData(prev => ({ ...prev, email, password: newPassword }));
            setShowRecovery(false);
            setEnableZK(true);
          }}
        />
      )}
    </div>
  );
}
