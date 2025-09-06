import React, { useState } from 'react';
import { Sun, Moon, Cloud, HardDrive, Shield, Zap, Database, Lock } from 'lucide-react';
import { useTheme } from '../../contexts/ThemeContext';
import { useAuth } from '../../contexts/AuthContext';
import { validateEmail, validatePassword, sanitizeInput } from '../../utils/security';

export default function AuthPage() {
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
    
    // Validate inputs
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
    } catch (err) {
      setError(authMode === 'login' ? 'Invalid credentials' : 'Registration failed');
    } finally {
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
    <div className={`min-h-screen ${darkMode ? 'dark bg-gray-900' : 'bg-gray-50'}`}>
      {/* Header */}
      <header className={`${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'} border-b`}>
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <h1 className={`text-xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              ☁️ Edge Cloud Storage
            </h1>
            <button
              onClick={toggleTheme}
              className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700 text-yellow-400' : 'bg-gray-100 text-gray-600'}`}
            >
              {darkMode ? <Sun size={20} /> : <Moon size={20} />}
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="container mx-auto p-6">
        {/* Hero Section */}
        <section className="text-center py-16">
          <h2 className={`text-4xl font-bold mb-4 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            Intelligent Edge Cloud Storage
          </h2>
          <p className={`text-lg max-w-2xl mx-auto mb-8 ${darkMode ? 'text-gray-300' : 'text-gray-600'}`}>
            Fast, secure, and intelligent storage with chunked deduplication, encryption, and tiered storage. 
            Upload, manage, and share content with enterprise-grade features.
          </p>
          
          {/* Login Form Card */}
          <div className={`max-w-md mx-auto p-8 rounded-lg shadow-lg ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            <div className="flex gap-2 mb-6">
              <button
                onClick={() => setAuthMode('login')}
                className={`flex-1 py-2 rounded-lg transition-colors ${
                  authMode === 'login' 
                    ? 'bg-blue-500 text-white' 
                    : darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'
                }`}
              >
                Login
              </button>
              <button
                onClick={() => setAuthMode('register')}
                className={`flex-1 py-2 rounded-lg transition-colors ${
                  authMode === 'register' 
                    ? 'bg-blue-500 text-white' 
                    : darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'
                }`}
              >
                Register
              </button>
            </div>
            
            {error && (
              <div className="mb-4 p-3 bg-red-100 dark:bg-red-900 text-red-700 dark:text-red-200 rounded-lg">
                {error}
              </div>
            )}
            
            <form onSubmit={handleSubmit}>
              <input
                type="email"
                name="email"
                placeholder="Email"
                required
                maxLength={100}
                value={formData.email}
                onChange={handleInputChange}
                disabled={loading}
                className={`w-full p-3 rounded-lg mb-4 transition-colors ${
                  darkMode ? 'bg-gray-700 text-white border-gray-600' : 'bg-white border border-gray-300'
                } ${loading ? 'opacity-50' : ''}`}
              />
              {authMode === 'register' && (
                <input
                  type="text"
                  name="username"
                  placeholder="Username"
                  required
                  maxLength={50}
                  value={formData.username}
                  onChange={handleInputChange}
                  disabled={loading}
                  className={`w-full p-3 rounded-lg mb-4 transition-colors ${
                    darkMode ? 'bg-gray-700 text-white border-gray-600' : 'bg-white border border-gray-300'
                  } ${loading ? 'opacity-50' : ''}`}
                />
              )}
              <input
                type="password"
                name="password"
                placeholder="Password"
                required
                minLength={8}
                value={formData.password}
                onChange={handleInputChange}
                disabled={loading}
                className={`w-full p-3 rounded-lg mb-4 transition-colors ${
                  darkMode ? 'bg-gray-700 text-white border-gray-600' : 'bg-white border border-gray-300'
                } ${loading ? 'opacity-50' : ''}`}
              />
              {authMode === 'register' && (
                <select
                  name="userType"
                  value={formData.userType}
                  onChange={handleInputChange}
                  disabled={loading}
                  className={`w-full p-3 rounded-lg mb-4 transition-colors ${
                    darkMode ? 'bg-gray-700 text-white border-gray-600' : 'bg-white border border-gray-300'
                  } ${loading ? 'opacity-50' : ''}`}
                >
                  <option value="individual">Individual (100GB)</option>
                  <option value="business">Business (1TB)</option>
                  <option value="enterprise">Enterprise (10TB)</option>
                </select>
              )}
              <button
                type="submit"
                disabled={loading}
                className={`w-full py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors ${
                  loading ? 'opacity-50 cursor-not-allowed' : ''
                }`}
              >
                {loading ? 'Processing...' : (authMode === 'login' ? 'Login' : 'Register')}
              </button>
            </form>
          </div>
        </section>

        {/* Features Grid */}
        <section className="grid grid-cols-1 md:grid-cols-3 gap-6 text-center mt-12">
          <FeatureCard
            icon={<Cloud className="text-blue-500" size={40} />}
            title="Tiered Edge Storage"
            description="Smart cache, warm, and cold storage tiers with automatic optimization based on access patterns."
            darkMode={darkMode}
          />
          <FeatureCard
            icon={<Shield className="text-green-500" size={40} />}
            title="Chunked Encryption"
            description="File-level encryption with chunked deduplication for optimal security and storage efficiency."
            darkMode={darkMode}
          />
          <FeatureCard
            icon={<Database className="text-purple-500" size={40} />}
            title="Distributed Cold Storage"
            description="Redundant archival with S3-compatible backup and multi-node replication for long-term reliability."
            darkMode={darkMode}
          />
        </section>

        {/* Platform Capabilities */}
        <section className="mt-20">
          <h2 className={`text-2xl font-bold text-center mb-6 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            Platform Capabilities
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <CapabilityCard
              title="Resumable Chunked Uploads"
              description="Large file uploads with resume support and progress tracking."
              darkMode={darkMode}
            />
            <CapabilityCard
              title="Smart Deduplication"
              description="Save space and bandwidth by detecting duplicate chunks across all files."
              darkMode={darkMode}
            />
            <CapabilityCard
              title="Storage Analytics"
              description="Real-time storage usage, tier distribution, and optimization insights."
              darkMode={darkMode}
            />
            <CapabilityCard
              title="Secure File Sharing"
              description="Time-limited, password-protected sharing with download tracking."
              darkMode={darkMode}
            />
            <CapabilityCard
              title="Hierarchical Organization"
              description="Folder-based organization with full path navigation and breadcrumbs."
              darkMode={darkMode}
            />
            <CapabilityCard
              title="Multi-Cloud Backup"
              description="Automatic backup to S3, multiple nodes, and local redundant storage."
              darkMode={darkMode}
            />
          </div>
        </section>

        {/* Technical Architecture */}
        <section className={`mt-20 p-8 rounded-xl ${darkMode ? 'bg-gray-800' : 'bg-blue-50'}`}>
          <h2 className={`text-2xl font-bold text-center mb-6 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            Technical Architecture
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div>
              <h3 className={`text-lg font-semibold mb-4 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Storage Tiers
              </h3>
              <ul className={`space-y-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                <li><strong>Cache Tier:</strong> High-speed storage for frequently accessed files</li>
                <li><strong>Warm Tier:</strong> Medium-speed storage for regularly accessed content</li>
                <li><strong>Cold Tier:</strong> Long-term archival storage with compression</li>
              </ul>
            </div>
            <div>
              <h3 className={`text-lg font-semibold mb-4 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Security Features
              </h3>
              <ul className={`space-y-2 ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                <li><strong>Encryption:</strong> AES-256 encryption for all stored data</li>
                <li><strong>Access Control:</strong> JWT-based authentication and authorization</li>
                <li><strong>Activity Logging:</strong> Comprehensive audit trail for all operations</li>
              </ul>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function FeatureCard({ icon, title, description, darkMode }) {
  return (
    <div className={`p-6 rounded-xl shadow transition-transform hover:scale-105 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
      <div className="flex justify-center mb-4">{icon}</div>
      <h3 className={`text-xl font-semibold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
        {title}
      </h3>
      <p className={darkMode ? 'text-gray-300' : 'text-gray-600'}>
        {description}
      </p>
    </div>
  );
}

function CapabilityCard({ title, description, darkMode }) {
  return (
    <div className={`p-6 rounded-xl shadow transition-transform hover:scale-105 ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
      <h4 className={`text-lg font-semibold mb-2 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
        {title}
      </h4>
      <p className={darkMode ? 'text-gray-300' : 'text-gray-600'}>
        {description}
      </p>
    </div>
  );
}