//path: frontend/src/components/EdgeCloudStorage.jsx
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Upload, File, X, CheckCircle, AlertCircle, Cloud, HardDrive, Share2, Download, Trash2, FolderPlus, Folder, Sun, Moon, User, LogOut, Home, Search, Settings, ChevronRight, Grid, List } from 'lucide-react';
//import { path } from '../../../services/web-service/src/app';

const API_URL = 'http://localhost:8001/api/v1';

// Utility functions
const formatBytes = (bytes) => {
  if (!bytes) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
};

const formatDate = (dateString) => {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
};

// Main Application Component
export default function EdgeCloudStorage() {
  const [darkMode, setDarkMode] = useState(false);
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [authMode, setAuthMode] = useState('login');
  const [files, setFiles] = useState([]);
  const [folders, setFolders] = useState([]);
  const [currentFolder, setCurrentFolder] = useState(null);
  const [uploads, setUploads] = useState({});
  const [isDragging, setIsDragging] = useState(false);
  const [viewMode, setViewMode] = useState('grid');
  const [searchQuery, setSearchQuery] = useState('');
  const [shareModal, setShareModal] = useState(null);
  const [storageStats, setStorageStats] = useState(null);
  const [activityLogs, setActivityLogs] = useState([]);
  
  const fileInputRef = useRef(null);
  const abortControllers = useRef({});
  const token = useRef(null);

  // Initialize and load data
  useEffect(() => {
    const savedTheme = localStorage.getItem('theme');
    if (savedTheme) {
      setDarkMode(savedTheme === 'dark');
    }
    
    const savedToken = localStorage.getItem('token');
    if (savedToken) {
      token.current = savedToken;
      setIsAuthenticated(true);
      loadUserData();
      loadFiles();
      loadStorageStats();
    }
  }, []);

  // Apply dark mode
  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('theme', 'light');
    }
    
    // Update user preference if logged in
    if (isAuthenticated) {
      fetch(`${API_URL}/users/theme`, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token.current}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ theme: darkMode ? 'dark' : 'light' })
      });
    }
  }, [darkMode, isAuthenticated]);

  // Authentication functions
  const handleAuth = async (e) => {
    e.preventDefault();
    const formData = new FormData(e.target);
    
    try {
      const response = await fetch(`${API_URL}/auth/${authMode}`, {
        method: 'POST',
        body: formData
      });
      
      if (!response.ok) throw new Error('Authentication failed');
      
      const data = await response.json();
      token.current = data.access_token;
      localStorage.setItem('token', data.access_token);
      setUser(data.user);
      setIsAuthenticated(true);
      setDarkMode(data.user.theme === 'dark');
      
      loadFiles();
      loadStorageStats();
    } catch (error) {
      alert(authMode === 'login' ? 'Invalid credentials' : 'Registration failed');
    }
  };

  const logout = () => {
    token.current = null;
    localStorage.removeItem('token');
    setIsAuthenticated(false);
    setUser(null);
    setFiles([]);
    setFolders([]);
  };

  // Load user data
  const loadUserData = async () => {
    try {
      const response = await fetch(`${API_URL}/user/profile`, {
        headers: { 'Authorization': `Bearer ${token.current}` }
      });
      if (response.ok) {
        const data = await response.json();
        setUser(data);
      }
    } catch (error) {
      console.error('Failed to load user data');
    }
  };

  // Load files and folders
  const loadFiles = async (folderId = null) => {
    try {
      const filesResponse = await fetch(
        `${API_URL}/files${folderId ? `?folder_id=${folderId}` : ''}`,
        { headers: { 'Authorization': `Bearer ${token.current}` } }
      );
      const foldersResponse = await fetch(
        `${API_URL}/folders${folderId ? `?parent_id=${folderId}` : ''}`,
        { headers: { 'Authorization': `Bearer ${token.current}` } }
      );
      
      if (filesResponse.ok && foldersResponse.ok) {
        setFiles(await filesResponse.json());
        setFolders(await foldersResponse.json());
      }
    } catch (error) {
      console.error('Failed to load files');
    }
  };

  // Load storage statistics
  const loadStorageStats = async () => {
    try {
      const response = await fetch(`${API_URL}/storage/stats`, {
        headers: { 'Authorization': `Bearer ${token.current}` }
      });
      if (response.ok) {
        setStorageStats(await response.json());
      }
    } catch (error) {
      console.error('Failed to load storage stats');
    }
  };

  // Load activity logs
  const loadActivityLogs = async () => {
    try {
      const response = await fetch(`${API_URL}/activity`, {
        headers: { 'Authorization': `Bearer ${token.current}` }
      });
      if (response.ok) {
        setActivityLogs(await response.json());
      }
    } catch (error) {
      console.error('Failed to load activity logs');
    }
  };

  // Create folder
  const createFolder = async () => {
    const name = prompt('Enter folder name:');
    if (!name) return;
    
    try {
      const response = await fetch(`${API_URL}/folders`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token.current}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ name, parent_id: currentFolder })
      });
      
      if (response.ok) {
        loadFiles(currentFolder);
      }
    } catch (error) {
      console.error('Failed to create folder');
    }
  };

  // Chunked upload with resume support
  const uploadFile = async (file) => {
    const CHUNK_SIZE = 64 * 1024 * 1024; // 64MB
    const uploadId = crypto.randomUUID();
    
    try {
      // Initialize upload
      const initResponse = await fetch(`${API_URL}/upload/init`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token.current}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          file_name: file.name,
          file_size: file.size,
          folder_id: currentFolder
        })
      });
      
      if (!initResponse.ok) throw new Error('Failed to initialize upload');
      
      const { upload_id, chunk_size, total_chunks } = await initResponse.json();
      
      // Create abort controller
      const controller = new AbortController();
      abortControllers.current[uploadId] = controller;
      
      // Initialize upload state
      setUploads(prev => ({
        ...prev,
        [uploadId]: {
          name: file.name,
          size: file.size,
          progress: 0,
          status: 'uploading',
          chunksUploaded: 0,
          totalChunks: total_chunks,
          startTime: Date.now()
        }
      }));
      
      // Upload chunks
      const uploadedChunks = [];
      for (let i = 0; i < total_chunks; i++) {
        const start = i * chunk_size;
        const end = Math.min(start + chunk_size, file.size);
        const chunk = file.slice(start, end);
        
        const formData = new FormData();
        formData.append('chunk', chunk);
        
        const response = await fetch(`${API_URL}/upload/chunk/${upload_id}?chunk_index=${i}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token.current}` },
          body: formData,
          signal: controller.signal
        });
        
        if (!response.ok) throw new Error('Chunk upload failed');
        
        uploadedChunks.push(i);
        
        // Update progress
        setUploads(prev => ({
          ...prev,
          [uploadId]: {
            ...prev[uploadId],
            chunksUploaded: uploadedChunks.length,
            progress: (uploadedChunks.length / total_chunks) * 100
          }
        }));
      }
      
      // Complete upload
      const completeResponse = await fetch(`${API_URL}/upload/complete/${upload_id}`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token.current}` }
      });
      
      if (!completeResponse.ok) throw new Error('Failed to complete upload');
      
      // Update state
      setUploads(prev => ({
        ...prev,
        [uploadId]: {
          ...prev[uploadId],
          status: 'completed',
          progress: 100
        }
      }));
      
      // Reload files
      loadFiles(currentFolder);
      loadStorageStats();
      
      // Remove from uploads after 3 seconds
      setTimeout(() => {
        setUploads(prev => {
          const newUploads = { ...prev };
          delete newUploads[uploadId];
          return newUploads;
        });
      }, 3000);
      
    } catch (error) {
      if (error.name === 'AbortError') {
        setUploads(prev => ({
          ...prev,
          [uploadId]: { ...prev[uploadId], status: 'cancelled' }
        }));
      } else {
        setUploads(prev => ({
          ...prev,
          [uploadId]: { ...prev[uploadId], status: 'error', error: error.message }
        }));
      }
    } finally {
      delete abortControllers.current[uploadId];
    }
  };

  // Cancel upload
  const cancelUpload = (uploadId) => {
    abortControllers.current[uploadId]?.abort();
  };

  // Download file
  const downloadFile = async (fileId, fileName) => {
    try {
      const response = await fetch(`${API_URL}/files/${fileId}/download`, {
        headers: { 'Authorization': `Bearer ${token.current}` }
      });
      
      if (!response.ok) throw new Error('Download failed');
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      alert('Failed to download file');
    }
  };

  // Delete file
  const deleteFile = async (fileId) => {
    if (!confirm('Are you sure you want to delete this file?')) return;
    
    try {
      const response = await fetch(`${API_URL}/files/${fileId}`, {
        method: 'DELETE',
        headers: { 'Authorization': `Bearer ${token.current}` }
      });
      
      if (response.ok) {
        loadFiles(currentFolder);
        loadStorageStats();
      }
    } catch (error) {
      alert('Failed to delete file');
    }
  };

  // Create share link
  const createShareLink = async (fileId) => {
    try {
      const response = await fetch(`${API_URL}/files/${fileId}/share`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token.current}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          expires_hours: 24,
          password: null,
          max_downloads: null
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        setShareModal(data);
      }
    } catch (error) {
      alert('Failed to create share link');
    }
  };

  // Drag and drop handlers
  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    
    const files = Array.from(e.dataTransfer.files);
    files.forEach(uploadFile);
  };

  // Authentication UI
  if (!isAuthenticated) {
    return (
      <div className={`min-h-screen ${darkMode ? 'dark bg-gray-900' : 'bg-gray-50'}`}>
        <div className="flex items-center justify-center min-h-screen">
          <div className={`w-full max-w-md p-8 rounded-lg shadow-lg ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            <div className="flex justify-between items-center mb-6">
              <h1 className={`text-2xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Edge Cloud Storage
              </h1>
              <button
                onClick={() => setDarkMode(!darkMode)}
                className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700 text-yellow-400' : 'bg-gray-100 text-gray-600'}`}
              >
                {darkMode ? <Sun size={20} /> : <Moon size={20} />}
              </button>
            </div>
            
            <div className="flex gap-2 mb-6">
              <button
                onClick={() => setAuthMode('login')}
                className={`flex-1 py-2 rounded-lg ${authMode === 'login' ? 'bg-blue-500 text-white' : darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'}`}
              >
                Login
              </button>
              <button
                onClick={() => setAuthMode('register')}
                className={`flex-1 py-2 rounded-lg ${authMode === 'register' ? 'bg-blue-500 text-white' : darkMode ? 'bg-gray-700 text-gray-300' : 'bg-gray-200 text-gray-700'}`}
              >
                Register
              </button>
            </div>
            
            <form onSubmit={handleAuth}>
              <input
                type="email"
                name="email"
                placeholder="Email"
                required
                className={`w-full p-3 rounded-lg mb-4 ${darkMode ? 'bg-gray-700 text-white' : 'bg-white border border-gray-300'}`}
              />
              {authMode === 'register' && (
                <input
                  type="text"
                  name="username"
                  placeholder="Username"
                  required
                  className={`w-full p-3 rounded-lg mb-4 ${darkMode ? 'bg-gray-700 text-white' : 'bg-white border border-gray-300'}`}
                />
              )}
              <input
                type="password"
                name="password"
                placeholder="Password"
                required
                className={`w-full p-3 rounded-lg mb-4 ${darkMode ? 'bg-gray-700 text-white' : 'bg-white border border-gray-300'}`}
              />
              {authMode === 'register' && (
                <select
                  name="user_type"
                  className={`w-full p-3 rounded-lg mb-4 ${darkMode ? 'bg-gray-700 text-white' : 'bg-white border border-gray-300'}`}
                >
                  <option value="individual">Individual (100GB)</option>
                  <option value="business">Business (1TB)</option>
                  <option value="enterprise">Enterprise (10TB)</option>
                </select>
              )}
              <button
                type="submit"
                className="w-full py-3 bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
              >
                {authMode === 'login' ? 'Login' : 'Register'}
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // Main Dashboard UI
  return (
    <div className={`min-h-screen ${darkMode ? 'dark bg-gray-900' : 'bg-gray-50'}`}>
      {/* Header */}
      <header className={`${darkMode ? 'bg-gray-800 border-gray-700' : 'bg-white border-gray-200'} border-b`}>
        <div className="max-w-7xl mx-auto px-4 py-4">
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-4">
              <h1 className={`text-xl font-bold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                <Cloud className="inline mr-2" size={24} />☁️
                Edge Cloud Storage
              </h1>
              <nav className="flex gap-2">
                <button
                  onClick={() => setCurrentFolder(null)}
                  className={`px-3 py-1 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-100'}`}
                >
                  <Home size={18} />
                </button>
              </nav>
            </div>
            
            <div className="flex items-center gap-3">
              <div className="relative">
                <input
                  type="text"
                  placeholder="Search files..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={`pl-10 pr-4 py-2 rounded-lg ${darkMode ? 'bg-gray-700 text-white' : 'bg-gray-100'}`}
                />
                <Search className="absolute left-3 top-2.5 text-gray-400" size={18} />
              </div>
              
              <button
                onClick={() => setViewMode(viewMode === 'grid' ? 'list' : 'grid')}
                className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}
              >
                {viewMode === 'grid' ? <List size={20} /> : <Grid size={20} />}
              </button>
              
              <button
                onClick={() => setDarkMode(!darkMode)}
                className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700 text-yellow-400' : 'bg-gray-100'}`}
              >
                {darkMode ? <Sun size={20} /> : <Moon size={20} />}
              </button>
              
              <div className="flex items-center gap-2">
                <span className={darkMode ? 'text-gray-300' : 'text-gray-600'}>
                  {user?.email}
                </span>
                <button
                  onClick={logout}
                  className={`p-2 rounded-lg ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}
                >
                  <LogOut size={20} />
                </button>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="max-w-7xl mx-auto px-4 py-6">
        {/* Storage Stats */}
        {storageStats && (
          <div className={`mb-6 p-4 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            <h2 className={`text-lg font-semibold mb-3 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Storage Usage
            </h2>
            <div className="mb-2">
              <div className="flex justify-between text-sm mb-1">
                <span className={darkMode ? 'text-gray-400' : 'text-gray-600'}>
                  {formatBytes(storageStats.used)} of {formatBytes(storageStats.quota)} used
                </span>
                <span className={darkMode ? 'text-gray-400' : 'text-gray-600'}>
                  {storageStats.percentage_used.toFixed(1)}%
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-500 h-2 rounded-full transition-all"
                  style={{ width: `${storageStats.percentage_used}%` }}
                />
              </div>
            </div>
            <div className="grid grid-cols-3 gap-4 mt-4">
              <div className="text-center">
                <Cloud className={`mx-auto mb-1 ${darkMode ? 'text-blue-400' : 'text-blue-500'}`} size={20} />
                <div className="text-xs text-gray-500">Cache</div>
                <div className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  {formatBytes(storageStats.distribution?.cache?.size || 0)}
                </div>
              </div>
              <div className="text-center">
                <HardDrive className={`mx-auto mb-1 ${darkMode ? 'text-green-400' : 'text-green-500'}`} size={20} />
                <div className="text-xs text-gray-500">Warm</div>
                <div className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  {formatBytes(storageStats.distribution?.warm?.size || 0)}
                </div>
              </div>
              <div className="text-center">
                <HardDrive className={`mx-auto mb-1 ${darkMode ? 'text-gray-400' : 'text-gray-500'}`} size={20} />
                <div className="text-xs text-gray-500">Cold</div>
                <div className={`text-sm font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  {formatBytes(storageStats.distribution?.cold?.size || 0)}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Action Bar */}
        <div className="flex gap-3 mb-6">
          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
          >
            <Upload size={20} />
            Upload Files
          </button>
          <button
            onClick={createFolder}
            className="flex items-center gap-2 px-4 py-2 bg-green-500 text-white rounded-lg hover:bg-green-600"
          >
            <FolderPlus size={20} />
            New Folder
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={(e) => Array.from(e.target.files).forEach(uploadFile)}
            className="hidden"
          />
        </div>

        {/* Upload Progress */}
        {Object.keys(uploads).length > 0 && (
          <div className={`mb-6 p-4 rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
            <h3 className={`text-lg font-semibold mb-3 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              Uploads
            </h3>
            {Object.entries(uploads).map(([id, upload]) => (
              <div key={id} className="mb-3">
                <div className="flex justify-between items-center mb-1">
                  <span className={`text-sm ${darkMode ? 'text-gray-300' : 'text-gray-700'}`}>
                    {upload.name}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-500">
                      {upload.chunksUploaded}/{upload.totalChunks} chunks
                    </span>
                    {upload.status === 'uploading' && (
                      <button
                        onClick={() => cancelUpload(id)}
                        className="text-red-500 hover:text-red-600"
                      >
                        <X size={16} />
                      </button>
                    )}
                    {upload.status === 'completed' && (
                      <CheckCircle className="text-green-500" size={16} />
                    )}
                    {upload.status === 'error' && (
                      <AlertCircle className="text-red-500" size={16} />
                    )}
                  </div>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2">
                  <div
                    className={`h-2 rounded-full transition-all ${
                      upload.status === 'completed' ? 'bg-green-500' :
                      upload.status === 'error' ? 'bg-red-500' : 'bg-blue-500'
                    }`}
                    style={{ width: `${upload.progress}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* File Browser */}
        <div
          className={`rounded-lg ${darkMode ? 'bg-gray-800' : 'bg-white'} ${isDragging ? 'ring-2 ring-blue-500' : ''}`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragging && (
            <div className="p-8 text-center border-2 border-dashed border-blue-500 m-4 rounded-lg">
              <Upload className="mx-auto mb-2 text-blue-500" size={48} />
              <p className="text-blue-500">Drop files here to upload</p>
            </div>
          )}
          
          {!isDragging && (
            <div className="p-4">
              {/* Breadcrumb */}
              <div className="flex items-center gap-2 mb-4 text-sm">
                <button
                  onClick={() => setCurrentFolder(null)}
                  className={`${darkMode ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-900'}`}
                >
                  Home
                </button>
                {currentFolder && (
                  <>
                    <ChevronRight size={16} className="text-gray-400" />
                    <span className={darkMode ? 'text-white' : 'text-gray-900'}>
                      Current Folder
                    </span>
                  </>
                )}
              </div>

              {/* Files and Folders Grid/List */}
              <div className={viewMode === 'grid' ? 'grid grid-cols-4 gap-4' : 'space-y-2'}>
                {/* Folders */}
                {folders.map(folder => (
                  <div
                    key={folder.id}
                    onClick={() => {
                      setCurrentFolder(folder.id);
                      loadFiles(folder.id);
                    }}
                    className={`${viewMode === 'grid' ? 'p-4' : 'p-3'} rounded-lg cursor-pointer transition-all ${
                      darkMode ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-50 hover:bg-gray-100'
                    }`}
                  >
                    <div className={`flex ${viewMode === 'grid' ? 'flex-col items-center' : 'items-center gap-3'}`}>
                      <Folder className="text-blue-500" size={viewMode === 'grid' ? 48 : 24} />
                      <div className={viewMode === 'grid' ? 'text-center mt-2' : 'flex-1'}>
                        <p className={`${viewMode === 'grid' ? 'text-sm' : ''} font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                          {folder.name}
                        </p>
                        {viewMode === 'list' && (
                          <p className="text-xs text-gray-500">{formatDate(folder.created_at)}</p>
                        )}
                      </div>
                    </div>
                  </div>
                ))}

                {/* Files */}
                {files.filter(file => 
                  !searchQuery || file.name.toLowerCase().includes(searchQuery.toLowerCase())
                ).map(file => (
                  <div
                    key={file.id}
                    className={`${viewMode === 'grid' ? 'p-4' : 'p-3'} rounded-lg ${
                      darkMode ? 'bg-gray-700 hover:bg-gray-600' : 'bg-gray-50 hover:bg-gray-100'
                    }`}
                  >
                    <div className={`flex ${viewMode === 'grid' ? 'flex-col items-center' : 'items-center justify-between'}`}>
                      <div className={`flex ${viewMode === 'grid' ? 'flex-col items-center' : 'items-center gap-3'}`}>
                        <File className="text-gray-400" size={viewMode === 'grid' ? 48 : 24} />
                        <div className={viewMode === 'grid' ? 'text-center mt-2' : ''}>
                          <p className={`${viewMode === 'grid' ? 'text-sm' : ''} font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                            {file.name}
                          </p>
                          <p className="text-xs text-gray-500">
                            {formatBytes(file.size)} • {formatDate(file.created_at)}
                          </p>
                        </div>
                      </div>
                      
                      <div className={`flex gap-2 ${viewMode === 'grid' ? 'mt-3' : ''}`}>
                        <button
                          onClick={() => downloadFile(file.id, file.name)}
                          className={`p-2 rounded ${darkMode ? 'hover:bg-gray-600' : 'hover:bg-gray-200'}`}
                          title="Download"
                        >
                          <Download size={16} />
                        </button>
                        <button
                          onClick={() => createShareLink(file.id)}
                          className={`p-2 rounded ${darkMode ? 'hover:bg-gray-600' : 'hover:bg-gray-200'}`}
                          title="Share"
                        >
                          <Share2 size={16} />
                        </button>
                        <button
                          onClick={() => deleteFile(file.id)}
                          className={`p-2 rounded ${darkMode ? 'hover:bg-gray-600' : 'hover:bg-gray-200'}`}
                          title="Delete"
                        >
                          <Trash2 size={16} className="text-red-500" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {files.length === 0 && folders.length === 0 && (
                <div className="text-center py-12">
                  <Upload className="mx-auto mb-3 text-gray-400" size={48} />
                  <p className={darkMode ? 'text-gray-400' : 'text-gray-500'}>
                    No files or folders yet. Upload some files or create a folder to get started!
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Share Modal */}
        {shareModal && (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
            <div className={`p-6 rounded-lg max-w-md w-full ${darkMode ? 'bg-gray-800' : 'bg-white'}`}>
              <h3 className={`text-lg font-semibold mb-4 ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                Share Link Created
              </h3>
              <div className={`p-3 rounded mb-4 ${darkMode ? 'bg-gray-700' : 'bg-gray-100'}`}>
                <p className="text-sm text-gray-500 mb-1">Share URL:</p>
                <p className={`text-sm break-all ${darkMode ? 'text-white' : 'text-gray-900'}`}>
                  {shareModal.share_url}
                </p>
              </div>
              <button
                onClick={() => {
                  navigator.clipboard.writeText(shareModal.share_url);
                  setShareModal(null);
                }}
                className="w-full py-2 bg-blue-500 text-white rounded-lg hover:bg-blue-600"
              >
                Copy Link & Close
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}