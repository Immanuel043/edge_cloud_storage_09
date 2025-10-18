import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sun, Moon, Cloud, Shield, Zap, Database, Lock, Upload, Download, Eye, ChevronRight, Check, Sparkles, Search, FileText, Copy, History, Share2, Scan, Gauge, RefreshCw, TrendingUp, Activity, Globe, Award } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import { validateEmail, validatePassword, sanitizeInput } from '../../utils/security';

export default function AuthPage() {
  const navigate = useNavigate();
  const { darkMode, toggleTheme } = useTheme();
  const { login, register } = useAuth();
  const [authMode, setAuthMode] = useState('login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [formData, setFormData] = useState({
    email: '',
    password: '',
    username: '',
    userType: 'individual'
  });

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (!validateEmail(formData.email)) {
      setError('Please enter a valid email address');
      return;
    }

    if (!validatePassword(formData.password)) {
      setError('Password must be at least 8 characters');
      return;
    }

    if (authMode === 'register' && formData.username.length < 3) {
      setError('Username must be at least 3 characters');
      return;
    }

    setLoading(true);

    try {
      if (authMode === 'login') {
        await login(formData.email, formData.password);
      } else {
        await register(
          formData.email,
          formData.password,
          formData.username,
          formData.userType
        );
      }
      navigate('/');
    } catch (err) {
      setError(authMode === 'login' ? 'Invalid credentials' : 'Registration failed');
      setLoading(false);
    }
  };

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({
      ...prev,
      [name]: sanitizeInput(value)
    }));
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

                {error && (
                  <div className={`mb-6 p-4 rounded-xl flex items-center gap-3 ${
                    darkMode ? 'bg-red-900/50 border border-red-700' : 'bg-red-50 border border-red-200'
                  }`}>
                    <div className="flex-shrink-0 w-2 h-2 bg-red-500 rounded-full animate-pulse"></div>
                    <p className={darkMode ? 'text-red-200' : 'text-red-700'}>{error}</p>
                  </div>
                )}

                <form onSubmit={handleSubmit} className="space-y-4">
                  <div>
                    <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                      Email Address
                    </label>
                    <input
                      type="email"
                      name="email"
                      placeholder="you@example.com"
                      required
                      maxLength={100}
                      value={formData.email}
                      onChange={handleInputChange}
                      disabled={loading}
                      className={`w-full px-4 py-3 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none ${
                        darkMode
                          ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                          : 'bg-gray-50 border border-gray-300 focus:bg-white'
                      } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                    />
                  </div>

                  {authMode === 'register' && (
                    <div>
                      <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                        Username
                      </label>
                      <input
                        type="text"
                        name="username"
                        placeholder="johndoe"
                        required
                        maxLength={50}
                        value={formData.username}
                        onChange={handleInputChange}
                        disabled={loading}
                        className={`w-full px-4 py-3 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none ${
                          darkMode
                            ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                            : 'bg-gray-50 border border-gray-300 focus:bg-white'
                        } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                      />
                    </div>
                  )}

                  <div>
                    <label className={`block text-sm font-medium mb-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                      Password
                    </label>
                    <input
                      type="password"
                      name="password"
                      placeholder="••••••••"
                      required
                      minLength={8}
                      value={formData.password}
                      onChange={handleInputChange}
                      disabled={loading}
                      className={`w-full px-4 py-3 rounded-xl transition-all focus:ring-2 focus:ring-blue-500 outline-none ${
                        darkMode
                          ? 'bg-gray-900 text-white border border-gray-700 focus:border-blue-500'
                          : 'bg-gray-50 border border-gray-300 focus:bg-white'
                      } ${loading ? 'opacity-50 cursor-not-allowed' : ''}`}
                    />
                  </div>

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
                    disabled={loading}
                    className={`w-full py-4 rounded-xl font-semibold text-white bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 transition-all shadow-lg hover:shadow-xl flex items-center justify-center gap-2 ${
                      loading ? 'opacity-50 cursor-not-allowed' : 'hover:scale-[1.02]'
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
