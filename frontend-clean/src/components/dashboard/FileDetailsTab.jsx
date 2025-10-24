import React, { useState } from 'react';
import {
  FileText, Calendar, HardDrive, Tag, MapPin, Download,
  Edit2, Plus, X, File, Image, Video, Music, Archive, Code
} from 'lucide-react';
import { formatBytes, formatDate } from '../../utils/helpers';

export default function FileDetailsTab({ file, onRename, darkMode }) {
  const [showAddTag, setShowAddTag] = useState(false);
  const [newTag, setNewTag] = useState('');
  const [tags, setTags] = useState(file.tags || []);

  const handleAddTag = () => {
    if (newTag.trim() && !tags.includes(newTag.trim())) {
      setTags([...tags, newTag.trim()]);
      setNewTag('');
      setShowAddTag(false);
      // TODO: API call to add tag
    }
  };

  const handleRemoveTag = (tagToRemove) => {
    setTags(tags.filter(tag => tag !== tagToRemove));
    // TODO: API call to remove tag
  };

  const getFileIcon = () => {
    const mimeType = file.mime_type || file.type || '';
    const name = file.name || '';

    if (mimeType.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|svg)$/i.test(name)) {
      return <Image size={20} className="text-blue-500" />;
    }
    if (mimeType.startsWith('video/') || /\.(mp4|avi|mov|wmv|webm)$/i.test(name)) {
      return <Video size={20} className="text-purple-500" />;
    }
    if (mimeType.startsWith('audio/') || /\.(mp3|wav|ogg|flac)$/i.test(name)) {
      return <Music size={20} className="text-pink-500" />;
    }
    if (mimeType.includes('zip') || mimeType.includes('tar') || mimeType.includes('rar') || /\.(zip|tar|gz|rar|7z)$/i.test(name)) {
      return <Archive size={20} className="text-orange-500" />;
    }
    if (mimeType.includes('code') || mimeType.includes('javascript') || mimeType.includes('python') || /\.(js|py|java|cpp|html|css)$/i.test(name)) {
      return <Code size={20} className="text-green-500" />;
    }
    return <FileText size={20} className="text-gray-500" />;
  };

  const getFileFormat = () => {
    const name = file.name || '';
    const extension = name.split('.').pop();
    return extension ? extension.toUpperCase() : 'Unknown';
  };

  return (
    <div className="space-y-6">
      {/* File Name */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h3 className={`text-sm font-semibold ${
            darkMode ? 'text-gray-300' : 'text-gray-700'
          }`}>
            File name
          </h3>
          {onRename && (
            <button
              onClick={() => onRename(file)}
              className={`p-1.5 rounded-lg transition-colors ${
                darkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-600'
              }`}
              title="Rename file"
            >
              <Edit2 size={14} />
            </button>
          )}
        </div>
        <div className={`flex items-center gap-3 p-3 rounded-lg ${
          darkMode ? 'bg-gray-700/50' : 'bg-gray-50'
        }`}>
          {getFileIcon()}
          <span className={`font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            {file.name}
          </span>
        </div>
      </div>

      {/* File Type & Format */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className={`text-sm font-semibold mb-2 ${
            darkMode ? 'text-gray-300' : 'text-gray-700'
          }`}>
            Type
          </p>
          <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
            {file.mime_type || 'Unknown'}
          </p>
        </div>
        <div>
          <p className={`text-sm font-semibold mb-2 ${
            darkMode ? 'text-gray-300' : 'text-gray-700'
          }`}>
            Format
          </p>
          <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
            {getFileFormat()}
          </p>
        </div>
      </div>

      {/* File Size */}
      <div>
        <p className={`text-sm font-semibold mb-2 ${
          darkMode ? 'text-gray-300' : 'text-gray-700'
        }`}>
          Size
        </p>
        <div className={`flex items-center gap-2 text-sm ${
          darkMode ? 'text-gray-400' : 'text-gray-600'
        }`}>
          <HardDrive size={16} />
          <span>{formatBytes(file.size)}</span>
        </div>
      </div>

      {/* Dates */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className={`text-sm font-semibold mb-2 ${
            darkMode ? 'text-gray-300' : 'text-gray-700'
          }`}>
            Created
          </p>
          <div className={`flex items-center gap-2 text-sm ${
            darkMode ? 'text-gray-400' : 'text-gray-600'
          }`}>
            <Calendar size={16} />
            <span>{formatDate(file.created_at)}</span>
          </div>
        </div>
        <div>
          <p className={`text-sm font-semibold mb-2 ${
            darkMode ? 'text-gray-300' : 'text-gray-700'
          }`}>
            Modified
          </p>
          <div className={`flex items-center gap-2 text-sm ${
            darkMode ? 'text-gray-400' : 'text-gray-600'
          }`}>
            <Calendar size={16} />
            <span>{formatDate(file.updated_at || file.created_at)}</span>
          </div>
        </div>
      </div>

      {/* Pages (for PDFs) */}
      {file.pages && (
        <div>
          <p className={`text-sm font-semibold mb-2 ${
            darkMode ? 'text-gray-300' : 'text-gray-700'
          }`}>
            Pages
          </p>
          <p className={`text-sm ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
            {file.pages} {file.pages === 1 ? 'page' : 'pages'}
          </p>
        </div>
      )}

      {/* Location */}
      <div>
        <p className={`text-sm font-semibold mb-2 ${
          darkMode ? 'text-gray-300' : 'text-gray-700'
        }`}>
          Location
        </p>
        <div className={`flex items-center gap-2 text-sm ${
          darkMode ? 'text-gray-400' : 'text-gray-600'
        }`}>
          <MapPin size={16} />
          <span>{file.folder_path || 'Cloud Drive'}</span>
        </div>
      </div>

      {/* Tags */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <p className={`text-sm font-semibold ${
            darkMode ? 'text-gray-300' : 'text-gray-700'
          }`}>
            Tags
          </p>
          {!showAddTag && (
            <button
              onClick={() => setShowAddTag(true)}
              className={`flex items-center gap-1 px-2 py-1 text-xs rounded-lg transition-colors ${
                darkMode
                  ? 'text-blue-400 hover:bg-blue-500/10'
                  : 'text-blue-600 hover:bg-blue-50'
              }`}
            >
              <Plus size={14} />
              Add tag
            </button>
          )}
        </div>

        {showAddTag && (
          <div className="flex items-center gap-2 mb-3">
            <input
              type="text"
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddTag();
                if (e.key === 'Escape') { setShowAddTag(false); setNewTag(''); }
              }}
              placeholder="Enter tag name"
              className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors ${
                darkMode
                  ? 'bg-gray-700 border-gray-600 text-white focus:border-blue-500'
                  : 'bg-white border-gray-300 text-gray-900 focus:border-blue-500'
              } focus:outline-none focus:ring-2 focus:ring-blue-500/20`}
              autoFocus
            />
            <button
              onClick={handleAddTag}
              className={`px-3 py-2 text-sm rounded-lg transition-colors ${
                darkMode
                  ? 'bg-blue-600 hover:bg-blue-700 text-white'
                  : 'bg-blue-500 hover:bg-blue-600 text-white'
              }`}
            >
              Add
            </button>
            <button
              onClick={() => { setShowAddTag(false); setNewTag(''); }}
              className={`p-2 rounded-lg transition-colors ${
                darkMode ? 'hover:bg-gray-700 text-gray-400' : 'hover:bg-gray-100 text-gray-600'
              }`}
            >
              <X size={16} />
            </button>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          {tags.length > 0 ? (
            tags.map((tag, index) => (
              <div
                key={index}
                className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm ${
                  darkMode
                    ? 'bg-blue-500/10 text-blue-400'
                    : 'bg-blue-50 text-blue-600'
                }`}
              >
                <Tag size={14} />
                <span>{tag}</span>
                <button
                  onClick={() => handleRemoveTag(tag)}
                  className={`p-0.5 rounded hover:bg-blue-500/20 transition-colors`}
                >
                  <X size={12} />
                </button>
              </div>
            ))
          ) : (
            <p className={`text-sm italic ${darkMode ? 'text-gray-500' : 'text-gray-400'}`}>
              No tags added yet
            </p>
          )}
        </div>
      </div>

      {/* Downloadable Toggle */}
      <div className={`flex items-center justify-between p-4 rounded-lg ${
        darkMode ? 'bg-gray-700/50' : 'bg-gray-50'
      }`}>
        <div className="flex items-center gap-3">
          <Download size={18} className={darkMode ? 'text-gray-400' : 'text-gray-600'} />
          <div>
            <p className={`text-sm font-medium ${darkMode ? 'text-white' : 'text-gray-900'}`}>
              File downloadable
            </p>
            <p className={`text-xs ${darkMode ? 'text-gray-500' : 'text-gray-500'}`}>
              Allow others to download this file
            </p>
          </div>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input type="checkbox" className="sr-only peer" defaultChecked />
          <div className={`w-11 h-6 rounded-full peer peer-checked:after:translate-x-full rtl:peer-checked:after:-translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:start-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all ${
            darkMode
              ? 'bg-gray-600 peer-checked:bg-blue-600'
              : 'bg-gray-300 peer-checked:bg-blue-500'
          }`}></div>
        </label>
      </div>
    </div>
  );
}
