import React, { useState, useEffect } from 'react';
import { X, ZoomIn, ZoomOut, RotateCw, Download } from 'lucide-react';
import { API_URL } from '../../config/constants';
import { useAuth } from '../../contexts/AuthContext';

export default function FilePreview({ file, onClose, darkMode }) {
  const { token } = useAuth();
  const [imageUrl, setImageUrl] = useState('');
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadPreview();
    return () => {
      if (imageUrl) {
        URL.revokeObjectURL(imageUrl);
      }
    };
  }, [file]);

  const loadPreview = async () => {
    try {
      const response = await fetch(`${API_URL}/files/${file.id}/preview`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (response.ok) {
        const blob = await response.blob();
        setImageUrl(URL.createObjectURL(blob));
      }
    } catch (error) {
      console.error('Failed to load preview:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleZoomIn = () => setZoom(prev => Math.min(prev + 0.25, 3));
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 0.25, 0.5));
  const handleRotate = () => setRotation(prev => (prev + 90) % 360);

  return (
    <div className="fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-50">
      <div className={`relative max-w-6xl w-full h-full flex flex-col ${darkMode ? 'bg-gray-900' : 'bg-white'}`}>
        {/* Header */}
        <div className={`flex justify-between items-center p-4 border-b ${
          darkMode ? 'bg-gray-800 border-gray-700' : 'bg-gray-100 border-gray-200'
        }`}>
          <h3 className={`text-lg font-semibold ${darkMode ? 'text-white' : 'text-gray-900'}`}>
            {file.name}
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={handleZoomOut}
              className={`p-2 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
              title="Zoom out"
            >
              <ZoomOut size={20} />
            </button>
            <span className={`px-2 ${darkMode ? 'text-gray-400' : 'text-gray-600'}`}>
              {Math.round(zoom * 100)}%
            </span>
            <button
              onClick={handleZoomIn}
              className={`p-2 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
              title="Zoom in"
            >
              <ZoomIn size={20} />
            </button>
            <button
              onClick={handleRotate}
              className={`p-2 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
              title="Rotate"
            >
              <RotateCw size={20} />
            </button>
            <button
              onClick={onClose}
              className={`p-2 rounded ${darkMode ? 'hover:bg-gray-700' : 'hover:bg-gray-200'}`}
              title="Close"
            >
              <X size={20} />
            </button>
          </div>
        </div>
        
        {/* Image viewer */}
        <div className="flex-1 overflow-auto flex items-center justify-center p-4">
          {loading ? (
            <div className={darkMode ? 'text-white' : 'text-gray-900'}>Loading preview...</div>
          ) : imageUrl ? (
            <img
              src={imageUrl}
              alt={file.name}
              style={{
                transform: `scale(${zoom}) rotate(${rotation}deg)`,
                transition: 'transform 0.3s ease'
              }}
              className="max-w-full max-h-full object-contain"
            />
          ) : (
            <div className={darkMode ? 'text-white' : 'text-gray-900'}>Preview not available</div>
          )}
        </div>
      </div>
    </div>
  );
}