# Quick Integration Guide

**Goal**: Integrate all new features into the Dashboard in 5 minutes

---

## Features to Integrate

1. ✅ Enhanced Analytics Dashboard (real API data)
2. ✅ URL Upload Modal
3. ✅ ZK File Download (already integrated)
4. ✅ ZK File Badges (already integrated)

---

## Step 1: Update Dashboard Imports

**File**: `frontend-clean/src/components/dashboard/Dashboard.jsx`

Add these imports at the top:

```jsx
import EnhancedAnalyticsView from './EnhancedAnalyticsView';
import URLUploadModal from './URLUploadModal';
```

---

## Step 2: Add URL Upload State

Add state for the URL upload modal:

```jsx
const [showURLUpload, setShowURLUpload] = useState(false);
```

---

## Step 3: Replace AnalyticsView

Find where `AnalyticsView` is used and replace it:

**Before**:
```jsx
{currentView === 'analytics' && (
  <AnalyticsView darkMode={darkMode} storageStats={storageStats} />
)}
```

**After**:
```jsx
{currentView === 'analytics' && (
  <EnhancedAnalyticsView darkMode={darkMode} storageStats={storageStats} />
)}
```

---

## Step 4: Add URL Upload Button

Find the upload button area and add a URL upload option:

```jsx
{/* Existing upload button */}
<button
  onClick={() => fileInputRef.current?.click()}
  className="..."
>
  <Upload size={20} />
  Upload File
</button>

{/* NEW: Add URL upload button */}
<button
  onClick={() => setShowURLUpload(true)}
  className={`px-4 py-2 rounded-lg font-medium transition-colors ${
    darkMode
      ? 'bg-gray-700 hover:bg-gray-600 text-white'
      : 'bg-gray-200 hover:bg-gray-300 text-gray-900'
  }`}
>
  <Download size={20} className="inline mr-2" />
  From URL
</button>
```

---

## Step 5: Add URL Upload Modal

Add the modal component at the end of the Dashboard render (before closing `</div>`):

```jsx
{/* URL Upload Modal */}
<URLUploadModal
  isOpen={showURLUpload}
  onClose={() => setShowURLUpload(false)}
  darkMode={darkMode}
  onUploadComplete={refreshFiles}
/>
```

---

## Complete Integration Example

Here's how the modified sections look together:

```jsx
// At top of Dashboard.jsx
import EnhancedAnalyticsView from './EnhancedAnalyticsView';
import URLUploadModal from './URLUploadModal';

export default function Dashboard() {
  // ... existing state ...
  const [showURLUpload, setShowURLUpload] = useState(false);

  // ... existing code ...

  return (
    <div className="...">
      {/* Header with upload buttons */}
      <div className="flex gap-2">
        <button onClick={() => fileInputRef.current?.click()}>
          <Upload size={20} /> Upload File
        </button>

        <button onClick={() => setShowURLUpload(true)}>
          <Download size={20} /> From URL
        </button>
      </div>

      {/* Views */}
      {currentView === 'home' && (
        // ... home view ...
      )}

      {currentView === 'analytics' && (
        <EnhancedAnalyticsView darkMode={darkMode} storageStats={storageStats} />
      )}

      {/* URL Upload Modal */}
      <URLUploadModal
        isOpen={showURLUpload}
        onClose={() => setShowURLUpload(false)}
        darkMode={darkMode}
        onUploadComplete={refreshFiles}
      />
    </div>
  );
}
```

---

## Verify Integration

After integration, test:

1. **Analytics**:
   - Click "Analytics" in sidebar
   - Should see real API data loading
   - Should see predictions, alerts, suggestions

2. **URL Upload**:
   - Click "From URL" button
   - Enter URL: `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf`
   - Click Upload
   - Should see success message

3. **ZK Download** (already working):
   - Upload file as ZK user
   - See lock badge
   - Click download
   - File decrypts automatically

---

## Optional: Add Keyboard Shortcut

Add keyboard shortcut for URL upload:

```jsx
useKeyboardShortcuts({
  'u': () => setShowURLUpload(true),  // Press 'u' to open URL upload
  // ... existing shortcuts ...
});
```

---

## Alternative: Quick Test Without Integration

You can test components standalone:

### Test Analytics:
Create a test page:
```jsx
// src/pages/TestAnalytics.jsx
import EnhancedAnalyticsView from '../components/dashboard/EnhancedAnalyticsView';

export default function TestAnalytics() {
  return <EnhancedAnalyticsView darkMode={false} />;
}
```

### Test URL Upload:
```jsx
// In browser console:
import URLUploadModal from './URLUploadModal';
// Manually render modal
```

---

## Troubleshooting

### Analytics not loading?
- Check browser console for errors
- Verify backend is running (port 8001)
- Check API endpoints are accessible
- Try force refresh

### URL Upload not working?
- Check backend logs
- Verify URL is publicly accessible
- Check user quota
- Verify network connectivity

### ZK Download not working?
- Check ZK session is unlocked
- Verify file has `is_encrypted` flag
- Check browser console for errors

---

## Done!

All features are now integrated and ready to use. The dashboard now has:

✅ Zero-Knowledge Encryption (auto-working)
✅ Enhanced Analytics with Real API Data
✅ URL Upload Feature
✅ ZK File Badges
✅ Auto Download Routing

**Total Integration Time**: ~5 minutes

**Next**: Test all features and deploy!
