# Trash/Bin and UI Improvements - Implementation Progress

## Status: IN PROGRESS (60% Complete)

## Implementation Date: October 24, 2025

---

## Features Implemented

### 1. Trash/Bin System with 30-Day Auto-Deletion ✅

#### Backend Changes (COMPLETED):

**Database Model Updates:**
- Added `is_deleted` (Boolean, default=False) to Object model
- Added `deleted_at` (DateTime, nullable=True) to Object model
- Added index `idx_is_deleted_deleted_at` for efficient trash queries
- Applied migration to production database

**API Endpoints Added:**
1. `DELETE /api/v1/files/{file_id}` - Modified to soft delete (move to trash)
2. `GET /api/v1/files/trash` - List files in trash
3. `POST /api/v1/files/trash/{file_id}/restore` - Restore file from trash
4. `DELETE /api/v1/files/trash/{file_id}/permanent` - Permanently delete file
5. `POST /api/v1/files/trash/empty` - Empty entire trash
6. `POST /api/v1/files/bulk-delete` - Modified to soft delete multiple files

**Activity Logging:**
- `file_moved_to_trash` - When file is soft deleted
- `file_restored_from_trash` - When file is restored
- `file_permanently_deleted` - When file is permanently deleted
- `trash_emptied` - When entire trash is emptied
- `bulk_moved_to_trash` - When multiple files are moved to trash

**Key Features:**
- Soft delete preserves files for 30 days
- All active file queries exclude deleted files (is_deleted=False filter)
- Physical file cleanup only happens on permanent delete
- Storage quota is freed only when files are permanently deleted
- User cannot access deleted files except through trash view

#### Frontend Changes (COMPLETED):

**Components Created:**
- `TrashView.jsx` - Main trash view component with empty trash button
  - Shows trashed files in grid/list view
  - Displays file count and 30-day warning
  - Empty state when trash is empty
  - Refresh button
  - Empty trash button with confirmation

**Service Methods Added (storageService.js):**
- `getTrash()` - Fetch files in trash
- `restoreFromTrash(fileId)` - Restore file from trash
- `permanentDelete(fileId)` - Permanently delete file
- `emptyTrash()` - Empty entire trash

**Features:**
- Restore button in file context menu (when in trash view)
- Permanent delete confirmation dialog
- Empty trash confirmation dialog
- Real-time trash file count
- Loading and error states

---

### 2. Replace Checkbox with Favorite Star Icon ⏳

#### Status: PENDING

**Plan:**
- Move favorite star from top-right to top-left position
- Remove selection checkbox completely
- Make favorite star always visible (not just on hover)
- File selection via clicking anywhere on card
- Selected files show blue ring border (already works)

**Files to Modify:**
- `FileGrid.jsx` (lines 68-85: Remove checkbox)
- `FileGrid.jsx` (lines 88-110: Move and update favorite star)
- `FileList.jsx` (similar changes)

---

### 3. Improve File Card Layout and Alignment ⏳

#### Status: PENDING

**Plan:**
- Better file name truncation with ellipsis
- Add metadata row: Owner info + Last accessed time
- Match Google Drive's card visual hierarchy
- Improve spacing and typography
- Better alignment of elements

**Files to Modify:**
- `FileGrid.jsx` - Card layout improvements
- `FileList.jsx` - List row improvements

---

### 4. Background Worker for 30-Day Auto-Deletion ⏳

#### Status: PENDING

**Plan:**
- Create scheduled job/worker
- Query files where `deleted_at < NOW() - INTERVAL '30 days'`
- Permanently delete old trash files
- Run daily or hourly
- Log deletions for audit

**Implementation Options:**
1. Python scheduler in background worker
2. Cron job calling cleanup endpoint
3. Database function with pg_cron extension

---

## API Endpoints Summary

### Trash Management

```
GET    /api/v1/files/trash
  - List all files in trash for current user
  - Ordered by deleted_at DESC

POST   /api/v1/files/trash/{file_id}/restore
  - Restore file from trash
  - Sets is_deleted=False, deleted_at=NULL

DELETE /api/v1/files/trash/{file_id}/permanent
  - Permanently delete file (cannot be recovered)
  - Deletes physical files and database record
  - Frees storage quota

POST   /api/v1/files/trash/empty
  - Permanently delete all files in trash
  - Batch operation
  - Returns count and freed space
```

### Modified Endpoints

```
DELETE /api/v1/files/{file_id}
  - Now performs soft delete (move to trash)
  - Sets is_deleted=True, deleted_at=NOW()
  - Does NOT delete physical files

POST   /api/v1/files/bulk-delete
  - Now performs soft delete on multiple files
  - Batch soft delete operation

GET    /api/v1/files
  - Now filters out deleted files
  - Added: WHERE is_deleted = False
```

---

## Frontend Integration

### New Views

**TrashView.jsx:**
- Located at: `frontend-clean/src/components/dashboard/TrashView.jsx`
- Props:
  - `viewMode` - grid or list
  - `darkMode` - theme support
  - `selectedFiles` - set of selected file IDs
  - `onFileClick`, `onFilePreview`, etc. - event handlers
  - `onRefresh` - refresh callback

**Features:**
- Empty trash button (with confirmation)
- Refresh button
- File count display
- 30-day warning message
- Empty state illustration
- Restore and permanent delete per file

### Service Integration

**storageService.js:**
- All trash operations use proper rate limiting
- Error handling with user-friendly messages
- Async/await pattern
- Cookie-based authentication

---

## Database Schema

### Object Table Updates

```sql
ALTER TABLE objects
ADD COLUMN is_deleted BOOLEAN DEFAULT FALSE,
ADD COLUMN deleted_at TIMESTAMP;

CREATE INDEX idx_is_deleted_deleted_at ON objects(is_deleted, deleted_at);
```

### View for Trash (Optional)

```sql
CREATE OR REPLACE VIEW trash_files AS
SELECT
    id,
    user_id,
    file_name,
    file_size,
    mime_type,
    created_at,
    deleted_at,
    EXTRACT(DAY FROM (NOW() - deleted_at)) as days_in_trash
FROM objects
WHERE is_deleted = TRUE AND deleted_at IS NOT NULL
ORDER BY deleted_at DESC;
```

---

## Testing Checklist

### Backend API Testing

- [x] DELETE file moves to trash (soft delete)
- [x] GET /trash lists trashed files
- [x] POST restore brings file back
- [x] DELETE permanent removes file completely
- [x] POST empty trash deletes all
- [ ] Bulk delete moves multiple files to trash
- [ ] Deleted files don't appear in regular file list
- [ ] Storage quota calculations are correct

### Frontend Testing

- [ ] Trash view shows in sidebar
- [ ] Trash view displays trashed files
- [ ] Restore button works
- [ ] Permanent delete works (with confirmation)
- [ ] Empty trash works (with confirmation)
- [ ] File count updates after operations
- [ ] Dark mode works correctly
- [ ] Loading and error states display correctly

---

## Next Steps

1. **Add Trash to Sidebar** ⏳
   - Add "Trash" menu item with Trash2 icon
   - Position below "Shared with me"
   - Route to TrashView

2. **Update Dashboard Routing** ⏳
   - Add trash view case
   - Import TrashView component
   - Pass required props

3. **Replace Checkbox with Favorite Star** ⏳
   - Modify FileGrid.jsx
   - Modify FileList.jsx
   - Test selection behavior

4. **Improve File Card Layout** ⏳
   - Update FileGrid card design
   - Add metadata row
   - Improve typography

5. **Create Auto-Deletion Worker** ⏳
   - Implement background job
   - Schedule daily execution
   - Add logging

---

## Files Modified

### Backend Files:
- `services/storage-service/app/models/database.py` - Added is_deleted, deleted_at columns
- `services/storage-service/app/routers/files.py` - Added trash endpoints, modified delete logic
- `services/storage-service/migrations/add_trash_functionality.sql` - Database migration

### Frontend Files:
- `frontend-clean/src/components/dashboard/TrashView.jsx` - Created
- `frontend-clean/src/services/storageService.js` - Added trash methods

### Pending Modifications:
- `frontend-clean/src/components/dashboard/Sidebar.jsx` - Add trash menu item
- `frontend-clean/src/components/dashboard/Dashboard.jsx` - Add trash routing
- `frontend-clean/src/components/dashboard/FileGrid.jsx` - UI improvements
- `frontend-clean/src/components/dashboard/FileList.jsx` - UI improvements

---

## Technical Decisions

1. **Soft Delete vs Hard Delete:**
   - Chose soft delete for trash functionality
   - Allows 30-day recovery period
   - Separates user action (delete) from physical cleanup

2. **Storage Quota Handling:**
   - Deleted files DON'T free quota immediately
   - Quota freed only on permanent delete
   - Encourages users to empty trash regularly

3. **Activity Logging:**
   - Separate actions for trash operations
   - Metadata tracks file names for audit
   - Helps users understand what happened

4. **Physical File Cleanup:**
   - Only happens on permanent delete
   - Prevents accidental data loss
   - Allows for future "undelete" recovery from backups

---

## Known Limitations

1. **Auto-Deletion Not Implemented:**
   - Background worker for 30-day cleanup needs to be created
   - Currently manual permanent delete only

2. **Folder Trash:**
   - Only files supported in trash currently
   - Folders need separate implementation

3. **Storage Quota Display:**
   - May confuse users (deleted files still count toward quota)
   - Need UI indicator that trash files use space

4. **Restore to Original Location:**
   - Currently restores to root folder
   - Should restore to original folder_id

---

## Performance Considerations

1. **Database Indexes:**
   - Composite index on (is_deleted, deleted_at) for efficient trash queries
   - Existing user_id index helps filter

2. **Batch Operations:**
   - Empty trash handles multiple files efficiently
   - Bulk soft delete is lightweight (just UPDATE query)

3. **Physical File Cleanup:**
   - Permanent delete handles chunked, single, and inline storage
   - Reference counting for deduplicated blocks

---

**Last Updated:** October 24, 2025
**Progress:** 60% Complete
**Next Session:** Complete UI improvements (checkbox → favorite, layout improvements, sidebar integration)
