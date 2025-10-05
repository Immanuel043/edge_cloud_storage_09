import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sun, Moon, Cloud, Shield, Zap, Database, Lock, Upload, Download, Eye, ChevronRight, Check, Sparkles, Search, FileText, Copy, History, Share2, Scan } from 'lucide-react';
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
                  Intelligent. Secure. Fast.
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
                <Sparkles className="text-blue-500" size={16} />
                <span className={`text-sm font-medium ${darkMode ? 'text-blue-300' : 'text-blue-600'}`}>
                  Production-Ready Cloud Storage
                </span>
              </div>

              <div>
                <h2 className={`text-5xl font-bold mb-4 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  Your Files,
                  <span className="bg-gradient-to-r from-blue-500 to-purple-600 bg-clip-text text-transparent"> Everywhere</span>
                </h2>
                <p className={`text-xl ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
                  Enterprise-grade storage with intelligent tiering, deduplication, and encryption. Built for performance and security.
                </p>
              </div>

              {/* Key Benefits */}
              <div className="space-y-4">
                <BenefitItem
                  icon={<Shield className="text-green-500" size={20} />}
                  title="Bank-Level Security"
                  description="AES-256 encryption with HTTP-only cookies"
                  darkMode={darkMode}
                />
                <BenefitItem
                  icon={<Zap className="text-yellow-500" size={20} />}
                  title="Lightning Fast"
                  description="Smart tiering with NVMe cache for instant access"
                  darkMode={darkMode}
                />
                <BenefitItem
                  icon={<Database className="text-blue-500" size={20} />}
                  title="50% Storage Savings"
                  description="Block-level deduplication across all files"
                  darkMode={darkMode}
                />
              </div>

              {/* Stats */}
              <div className={`grid grid-cols-3 gap-4 p-6 rounded-2xl ${darkMode ? 'bg-gray-800/50' : 'bg-white/50'} backdrop-blur-sm border ${darkMode ? 'border-gray-700' : 'border-gray-200'}`}>
                <StatItem value="99.9%" label="Uptime" darkMode={darkMode} />
                <StatItem value="8TB" label="Capacity" darkMode={darkMode} />
                <StatItem value="500+" label="Users" darkMode={darkMode} />
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
                        <option value="business">Business - 1TB</option>
                        <option value="enterprise">Enterprise - 10TB</option>
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
              </div>
            </div>
          </div>
        </section>

        {/* Features Grid */}
        <section className="mt-24 max-w-6xl mx-auto">
          <div className="text-center mb-12">
            <h3 className={`text-3xl font-bold mb-4 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Built for Modern Teams
            </h3>
            <p className={`text-lg ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              Everything you need to store, share, and manage files at scale
            </p>
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
            <FeatureCard
              icon={<Upload className="text-blue-500" size={32} />}
              title="Resumable Uploads"
              description="Upload large files with automatic resume on connection loss. Never lose progress."
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<Eye className="text-green-500" size={32} />}
              title="Universal Preview"
              description="Preview images, PDFs, videos, documents, and code files directly in browser."
              darkMode={darkMode}
            />
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
              icon={<Zap className="text-yellow-500" size={32} />}
              title="Auto-Tiering"
              description="Files automatically move between hot, warm, and cold storage tiers."
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<Download className="text-indigo-500" size={32} />}
              title="Fast Downloads"
              description="Parallel chunk downloads with resume support for maximum speed."
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<Scan className="text-orange-500" size={32} />}
              title="AI-Powered OCR"
              description="Extract text from scanned documents and images with multi-language support."
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<Search className="text-cyan-500" size={32} />}
              title="Smart Search"
              description="Full-text search across files, folders, and OCR-extracted content with Elasticsearch."
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<Copy className="text-pink-500" size={32} />}
              title="Duplicate Detection"
              description="Find similar images and near-duplicate files using perceptual hashing."
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<FileText className="text-teal-500" size={32} />}
              title="Metadata Extraction"
              description="Auto-extract EXIF, ID3, PDF properties, and document metadata."
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<History className="text-violet-500" size={32} />}
              title="File Versioning"
              description="Track complete version history with rollback support and change tracking."
              darkMode={darkMode}
            />
            <FeatureCard
              icon={<Share2 className="text-emerald-500" size={32} />}
              title="Secure Sharing"
              description="Share files with expiring links, password protection, and access controls."
              darkMode={darkMode}
            />
          </div>
        </section>

        {/* Footer */}
        <footer className={`mt-24 pt-8 border-t ${darkMode ? 'border-gray-800' : 'border-gray-200'}`}>
          <p className={`text-center text-sm ${darkMode ? 'text-gray-500' : 'text-gray-600'}`}>
            © 2025 Edge Cloud Storage. Production-ready edge storage platform with intelligent tiering.
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
      <div className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
        {value}
      </div>
      <div className={`text-xs ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
        {label}
      </div>
    </div>
  );
}

function FeatureCard({ icon, title, description, darkMode }) {
  return (
    <div className={`p-6 rounded-2xl transition-all hover:scale-105 hover:shadow-xl border ${
      darkMode
        ? 'bg-gray-800/50 border-gray-700 hover:bg-gray-800'
        : 'bg-white border-gray-200 hover:shadow-2xl'
    }`}>
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
