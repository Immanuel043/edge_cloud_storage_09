# UI/UX Features Testing Guide

## Services Status
✅ **Backend**: Running on http://localhost:8001/
✅ **Frontend**: Running on http://localhost:4173/

All services are healthy and ready for testing.

---

## Test 1: File Rename Functionality

### Backend Endpoint
- **Method**: `PATCH /api/v1/files/{file_id}/rename`
- **Location**: [files.py:709-812](services/storage-service/app/routers/files.py#L709-L812)

### Testing Steps

1. **Login to the application**
   - Navigate to http://localhost:4173/
   - Login with your credentials (or register a new account)

2. **Upload a test file**
   - Click "Upload" button
   - Select any file (e.g., a text file or image)
   - Wait for upload to complete

3. **Test successful rename**
   - Right-click on the uploaded file (or click the three-dot menu)
   - Look for "Rename" option in the context menu
   - Click "Rename"
   - Enter a new name (e.g., "test-renamed.txt")
   - Click "Save" or press Enter
   - ✅ Verify: File name updates in the UI
   - ✅ Verify: Success message appears

4. **Test validation - Empty name**
   - Try to rename the file again
   - Leave the name field empty
   - ✅ Verify: Error message "File name cannot be empty" appears

5. **Test validation - Invalid characters**
   - Try to rename with invalid characters: `test<>:.txt`
   - ✅ Verify: Error message about invalid characters appears
   - Invalid characters: `< > : " / \ | ? *`

6. **Test validation - Duplicate name**
   - Upload a second file with a different name
   - Try to rename the second file to match the first file's name
   - ✅ Verify: Error message "A file with this name already exists" appears

7. **Test validation - Name too long**
   - Try to rename with a name longer than 255 characters
   - ✅ Verify: Error message "File name too long" appears

### Expected Results
- ✅ Successful rename updates the file name immediately
- ✅ All validation errors show helpful messages
- ✅ Activity log records the rename action (check in File Information panel)

---

## Test 2: File Information Panel

### Components Created
- [FileInfoPanel.jsx](frontend-clean/src/components/dashboard/FileInfoPanel.jsx)
- [FileDetailsTab.jsx](frontend-clean/src/components/dashboard/FileDetailsTab.jsx)
- [FileActivityTab.jsx](frontend-clean/src/components/dashboard/FileActivityTab.jsx)
- [FileSecurityTab.jsx](frontend-clean/src/components/dashboard/FileSecurityTab.jsx)

### Testing Steps

1. **Open File Information Panel**
   - Right-click on any file
   - Click "File information" (with Info icon)
   - ✅ Verify: Panel slides in from the right side
   - ✅ Verify: Overlay appears behind the panel
   - ✅ Verify: Panel shows file name in header

2. **Test Details Tab**
   - The Details tab should be active by default
   - ✅ Verify: Shows file type icon
   - ✅ Verify: Shows file name (editable with rename button)
   - ✅ Verify: Shows file size
   - ✅ Verify: Shows last modified date
   - ✅ Verify: Shows location/path
   - ✅ Verify: Shows downloadable toggle
   - ✅ Verify: Shows tags section (if any tags exist)

   **Test rename from Details tab:**
   - Click the pencil/rename button next to file name
   - Enter a new name
   - Click "Save"
   - ✅ Verify: File name updates in both panel and main view

3. **Test Activity Tab**
   - Click the "Activity" tab
   - ✅ Verify: Shows loading state while fetching
   - ✅ Verify: Shows timeline of activities
   - ✅ Verify: Each activity shows:
     - Icon (based on action type)
     - Action description
     - Timestamp
     - Metadata (for rename: shows "old name" → "new name")

   **Test with rename action:**
   - Rename the file from Details tab
   - Switch back to Activity tab
   - ✅ Verify: New "file_renamed" activity appears at top
   - ✅ Verify: Shows old and new names

4. **Test Security Tab**
   - Click the "Security" tab
   - ✅ Verify: Shows encryption status (AES-256-GCM)
   - ✅ Verify: Shows virus scan status
   - ✅ Verify: Shows user permissions (view, download, edit, share)
   - ✅ Verify: Shows "Shared with" section (if file is shared)
   - ✅ Verify: Shows security tips

5. **Test Panel Interactions**
   - ✅ Verify: Can switch between tabs smoothly
   - ✅ Verify: Click overlay to close panel
   - ✅ Verify: Click X button in header to close panel
   - ✅ Verify: Panel closes with smooth animation
   - ✅ Verify: Can open panel for different files
   - ✅ Verify: Panel shows different data for each file

### Expected Results
- ✅ Panel slides in/out smoothly
- ✅ All tabs display correct information
- ✅ Activity tab shows real-time updates
- ✅ Rename from Details tab works and logs activity

---

## Test 3: Shared With Me Section

### Components Created
- [SharedWithMeView.jsx](frontend-clean/src/components/dashboard/SharedWithMeView.jsx)
- [useSharedWithMe.js](frontend-clean/src/hooks/useSharedWithMe.js)

### Backend Endpoint
- **Method**: `GET /api/v1/shared-with-me`
- Endpoint already exists in backend

### Testing Steps

1. **Navigate to Shared With Me**
   - Look in the left sidebar
   - Click "Shared with me" (with Users icon)
   - ✅ Verify: View changes to shared files section
   - ✅ Verify: Shows header "Shared with me"

2. **Test with no shared files**
   - If no files are shared with you:
   - ✅ Verify: Shows empty state message
   - ✅ Verify: Shows friendly illustration/icon
   - ✅ Verify: Shows helpful text

3. **Test with shared files** (requires two accounts)
   - **Setup**: Login with Account A, share a file with Account B
   - **Test**: Login with Account B
   - Navigate to "Shared with me"
   - ✅ Verify: Shared file appears in the list
   - ✅ Verify: Shows file name, size, type
   - ✅ Verify: Shows who shared it (Account A's name)
   - ✅ Verify: Can use grid or list view

4. **Test file operations on shared files**
   - Right-click on a shared file
   - ✅ Verify: Can view file information
   - ✅ Verify: Can download (if permission granted)
   - ✅ Verify: Context menu shows appropriate actions based on permissions

5. **Test refresh**
   - ✅ Verify: Can refresh the shared files list
   - ✅ Verify: Shows loading state during refresh

### Expected Results
- ✅ Sidebar shows "Shared with me" option with Users icon
- ✅ Empty state when no shared files
- ✅ Shared files display correctly with sharer information
- ✅ File operations respect permissions

---

## Test 4: File Activity Logging

### Backend Endpoint
- **Method**: `GET /api/v1/files/{file_id}/activity`
- **Location**: [files.py:814-874](services/storage-service/app/routers/files.py#L814-L874)

### Testing Steps

1. **Generate activity**
   - Upload a file → creates "file_uploaded" activity
   - Rename the file → creates "file_renamed" activity
   - Download the file → creates "file_downloaded" activity
   - Share the file → creates "file_shared" activity

2. **View activity in File Information Panel**
   - Right-click file → "File information"
   - Click "Activity" tab
   - ✅ Verify: All activities appear in chronological order (newest first)
   - ✅ Verify: Each activity shows correct icon and color
   - ✅ Verify: Timestamps are displayed correctly

3. **Test activity types**
   - **file_uploaded**: Shows upload icon (green)
   - **file_renamed**: Shows edit icon (blue), displays old → new name
   - **file_downloaded**: Shows download icon (cyan)
   - **file_shared**: Shows share icon (purple)
   - **file_deleted**: Shows trash icon (red)

4. **Test metadata display**
   - Focus on rename activities
   - ✅ Verify: Shows 'Renamed from "old_name" to "new_name"'
   - ✅ Verify: Metadata is properly parsed and displayed

### Expected Results
- ✅ All file operations are logged
- ✅ Activity timeline is accurate and complete
- ✅ Metadata provides context for each action
- ✅ Activities are user-specific (only show user's own actions)

---

## Test 5: Dark Mode Compatibility

### Testing Steps

1. **Toggle dark mode**
   - Look for dark mode toggle in the UI (usually top-right)
   - Click to switch to dark mode

2. **Test File Information Panel in dark mode**
   - ✅ Verify: Panel background is dark (gray-800)
   - ✅ Verify: Text is light and readable
   - ✅ Verify: Tabs have dark styling
   - ✅ Verify: Icons are visible
   - ✅ Verify: Borders and separators are visible

3. **Test Shared With Me in dark mode**
   - Navigate to "Shared with me"
   - ✅ Verify: View has dark background
   - ✅ Verify: Empty state text is readable
   - ✅ Verify: File cards have dark styling

4. **Test context menus in dark mode**
   - Right-click on files
   - ✅ Verify: Menu has dark background (gray-800)
   - ✅ Verify: Menu items are readable
   - ✅ Verify: Hover states work correctly

### Expected Results
- ✅ All new components support dark mode
- ✅ Text contrast is sufficient for readability
- ✅ UI elements are visible in both modes

---

## Test 6: End-to-End Flow

### Complete User Journey

1. **Upload and organize**
   - Upload 2-3 test files
   - ✅ Verify: Files appear in main view

2. **Rename workflow**
   - Open File Information panel for File 1
   - Check Activity tab → should show "file_uploaded"
   - Go to Details tab → rename the file
   - Go back to Activity tab → should show both "file_uploaded" and "file_renamed"
   - ✅ Verify: Timeline updates immediately

3. **Share and verify**
   - Share File 1 with another user (if sharing UI exists)
   - Login as the other user
   - Navigate to "Shared with me"
   - ✅ Verify: File 1 appears
   - ✅ Verify: Shows correct sharer information

4. **Cross-feature testing**
   - From "Shared with me", open File Information panel
   - ✅ Verify: Activity tab works for shared files
   - ✅ Verify: Details tab shows correct information
   - ✅ Verify: Security tab shows sharing information

---

## Summary Checklist

### Backend Implementation
- ✅ PATCH /api/v1/files/{file_id}/rename - Rename endpoint with validation
- ✅ GET /api/v1/files/{file_id}/activity - Activity logging endpoint
- ✅ GET /api/v1/shared-with-me - Shared files endpoint (already existed)
- ✅ Activity logging with metadata (rename shows old → new name)
- ✅ All endpoints use rate limiting
- ✅ Proper error handling and validation

### Frontend Implementation
- ✅ SharedWithMeView component with grid/list views
- ✅ useSharedWithMe custom hook
- ✅ FileInfoPanel with slide-in animation
- ✅ FileDetailsTab with rename functionality
- ✅ FileActivityTab with real-time data
- ✅ FileSecurityTab with permissions display
- ✅ "Shared with me" sidebar menu item
- ✅ "File information" context menu option
- ✅ Dark mode support for all components
- ✅ Loading and error states

### Integration
- ✅ storageService.getSharedWithMe() - correct endpoint path
- ✅ storageService.getFileActivity() - new method
- ✅ File rename triggers activity log
- ✅ Activity tab fetches and displays real data
- ✅ All components properly integrated into Dashboard

---

## Known Limitations

1. **Tags functionality**: Frontend UI exists, but backend integration for adding/removing tags from Details tab needs API calls implementation
2. **Share link creation**: Security tab shows share links section but actual link generation may need testing
3. **Multiple users**: Full "Shared with me" testing requires two user accounts

---

## Next Steps for You

1. **Open the application**: http://localhost:4173/
2. **Register/Login** with a test account
3. **Follow the test cases above** in sequence
4. **Report any issues** you find

All implemented features are ready for testing! 🚀
