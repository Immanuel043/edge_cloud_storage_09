# Testing & Verification Checklist

## Status: Ready for User Testing

**Date**: October 24, 2025
**Frontend**: http://localhost:4173/ ✅ Running
**Backend**: http://localhost:8001/ ✅ Healthy
**Build Status**: ✅ No compilation errors

---

## Pre-Testing Verification

### ✅ Code Compilation
- [x] Frontend builds without errors
- [x] Backend starts without errors
- [x] No import/syntax errors
- [x] All new components exist

### ✅ Services Health
- [x] PostgreSQL: Connected
- [x] Redis: Connected
- [x] Storage Service: Running
- [x] Frontend Server: Running

### ✅ Database Schema
- [x] `is_deleted` column added to objects table
- [x] `deleted_at` column added to objects table
- [x] Index `idx_is_deleted_deleted_at` created

---

## Manual Testing Required

### Test 1: Trash Functionality

#### 1.1 Navigate to Trash
- [ ] Open http://localhost:4173/
- [ ] Login with your account
- [ ] Look in left sidebar
- [ ] **Verify**: "Trash" menu item exists with 🗑️ icon
- [ ] Click "Trash"
- [ ] **Verify**: Trash view loads without errors

#### 1.2 Delete a File (Move to Trash)
- [ ] Go back to "Cloud Drive" view
- [ ] Right-click on any file
- [ ] Click "Delete"
- [ ] **Verify**: File disappears from Cloud Drive
- [ ] Navigate to "Trash"
- [ ] **Verify**: File appears in trash with deletion timestamp

#### 1.3 Restore from Trash
- [ ] In Trash view, right-click on a deleted file
- [ ] **Verify**: "Restore" option appears in menu
- [ ] Click "Restore"
- [ ] **Verify**: Success message appears
- [ ] **Verify**: File disappears from trash
- [ ] Go to "Cloud Drive"
- [ ] **Verify**: File reappears in Cloud Drive

#### 1.4 Permanent Delete
- [ ] Delete another file (move to trash)
- [ ] Go to Trash view
- [ ] Right-click on the file
- [ ] Click "Delete Permanently"
- [ ] **Verify**: Confirmation dialog appears
- [ ] Confirm deletion
- [ ] **Verify**: File disappears from trash
- [ ] **Verify**: Cannot be recovered

#### 1.5 Empty Trash
- [ ] Delete 2-3 files (move to trash)
- [ ] Go to Trash view
- [ ] **Verify**: File count shows in header (e.g., "3 files")
- [ ] Click "Empty Trash" button
- [ ] **Verify**: Confirmation dialog appears
- [ ] Confirm
- [ ] **Verify**: All files disappear
- [ ] **Verify**: Empty state shows ("Trash is empty")

---

### Test 2: Favorite Star in Grid View

#### 2.1 Star Visibility
- [ ] Go to "Cloud Drive" (Grid view)
- [ ] Look at any file card
- [ ] **Verify**: Star icon visible in top-left corner (WITHOUT hovering)
- [ ] **Verify**: No checkbox visible anywhere

#### 2.2 Add to Favorites
- [ ] Click the star icon on an unfavorite file
- [ ] **Verify**: Star fills with yellow color (⭐)
- [ ] Go to "Favorites" view
- [ ] **Verify**: File appears in favorites

#### 2.3 Remove from Favorites
- [ ] Go back to "Cloud Drive"
- [ ] Click the yellow star on a favorited file
- [ ] **Verify**: Star becomes outline (☆)
- [ ] Go to "Favorites" view
- [ ] **Verify**: File removed from favorites

#### 2.4 Star Position
- [ ] Look at file cards in grid view
- [ ] **Verify**: Star is in top-left corner
- [ ] **Verify**: Three-dot menu is in top-right corner
- [ ] **Verify**: No checkbox anywhere on the card

---

### Test 3: Favorite Star in List View

#### 3.1 Switch to List View
- [ ] Click list view toggle (list icon in toolbar)
- [ ] **Verify**: View switches to list/table

#### 3.2 Table Header
- [ ] Look at table header
- [ ] **Verify**: First column shows "★" symbol
- [ ] **Verify**: No "Favorite" or "Select" column header
- [ ] **Verify**: Column headers: "★", "Name", "Size", "Last Opened", empty, "Actions"

#### 3.3 Star in First Column
- [ ] Look at any file row
- [ ] **Verify**: Star icon in first column (always visible)
- [ ] **Verify**: No checkbox in any column

#### 3.4 Add/Remove Favorites
- [ ] Click star in first column on an unfavorite file
- [ ] **Verify**: Star fills yellow
- [ ] Click yellow star again
- [ ] **Verify**: Star becomes outline

---

### Test 4: File Selection (No Checkbox)

#### 4.1 Grid View Selection
- [ ] Go to grid view
- [ ] Click anywhere on a file card (NOT on star, NOT on menu)
- [ ] **Verify**: Blue ring appears around card (ring-2 ring-blue-500)
- [ ] Click the card again
- [ ] **Verify**: Blue ring disappears (deselected)
- [ ] Click the star icon
- [ ] **Verify**: Favorite toggles BUT card is NOT selected
- [ ] Click the three-dot menu
- [ ] **Verify**: Menu opens BUT card is NOT selected

#### 4.2 List View Selection
- [ ] Go to list view
- [ ] Click on the file name area of a row
- [ ] **Verify**: Row background highlights (blue tint)
- [ ] Click the row again
- [ ] **Verify**: Highlight disappears (deselected)
- [ ] Click the star icon
- [ ] **Verify**: Favorite toggles BUT row is NOT selected
- [ ] Click the three-dot menu
- [ ] **Verify**: Menu opens BUT row is NOT selected

#### 4.3 Multi-Select
- [ ] Click multiple file cards/rows
- [ ] **Verify**: Multiple files can be selected simultaneously
- [ ] **Verify**: Blue rings/highlights on all selected files
- [ ] **Verify**: Bulk actions toolbar appears (if implemented)

---

### Test 5: Improved File Layout

#### 5.1 Grid View Layout
- [ ] Look at file cards in grid view
- [ ] **Verify**: File name shows up to 2 lines before truncating
- [ ] **Verify**: Metadata row shows: "Size • Time" (e.g., "2.5 MB • 2h ago")
- [ ] **Verify**: Time shows "Last Opened" (not just date)
- [ ] **Verify**: Text is properly aligned and readable

#### 5.2 List View Layout
- [ ] Look at rows in list view
- [ ] **Verify**: "Last Opened" column shows relative time (e.g., "2 hours ago", "Yesterday")
- [ ] **Verify**: Size and time text is larger (text-sm, not text-xs)
- [ ] **Verify**: Better color contrast for metadata
- [ ] **Verify**: Proper spacing between columns

#### 5.3 Long File Names
- [ ] Upload/create a file with a very long name
- [ ] In Grid view: **Verify** name shows 2 lines then "..."
- [ ] In List view: **Verify** name truncates with "..." on one line
- [ ] Hover over name: **Verify** tooltip shows full name

---

### Test 6: Dark Mode

#### 6.1 Toggle Dark Mode
- [ ] Click dark mode toggle (moon/sun icon)
- [ ] **Verify**: UI switches to dark theme

#### 6.2 Trash in Dark Mode
- [ ] Navigate to Trash view
- [ ] **Verify**: Dark background (gray-800)
- [ ] **Verify**: Text is readable (light color)
- [ ] **Verify**: Empty Trash button visible
- [ ] **Verify**: File cards/rows have dark styling

#### 6.3 Stars in Dark Mode
- [ ] Go to Cloud Drive
- [ ] **Verify**: Unfavorite stars are visible (gray-500)
- [ ] **Verify**: Favorite stars are yellow (same as light mode)
- [ ] **Verify**: Star hover shows yellow tint

#### 6.4 Selection in Dark Mode
- [ ] Select a file in grid view
- [ ] **Verify**: Blue ring is visible
- [ ] Select a file in list view
- [ ] **Verify**: Row highlight is visible

---

### Test 7: Backend API Verification

#### 7.1 Test Trash Endpoints
```bash
# Get files in trash
curl -X GET http://localhost:8001/api/v1/files/trash \
  -H "Cookie: <your-session-cookie>"

# Expected: Array of deleted files
```

#### 7.2 Test Soft Delete
```bash
# Delete a file (should soft delete)
curl -X DELETE http://localhost:8001/api/v1/files/{file_id} \
  -H "Cookie: <your-session-cookie>"

# Expected: {"status": "success", "message": "File moved to trash"}
```

#### 7.3 Test Restore
```bash
# Restore from trash
curl -X POST http://localhost:8001/api/v1/files/trash/{file_id}/restore \
  -H "Cookie: <your-session-cookie>"

# Expected: {"status": "success", "message": "File restored from trash"}
```

#### 7.4 Verify Database
```sql
-- Check if deleted files have is_deleted = TRUE
SELECT id, file_name, is_deleted, deleted_at
FROM objects
WHERE is_deleted = TRUE
LIMIT 5;

-- Check if restored files have is_deleted = FALSE
SELECT id, file_name, is_deleted, deleted_at
FROM objects
WHERE is_deleted = FALSE
LIMIT 5;
```

---

### Test 8: Error Handling

#### 8.1 Empty Trash Confirmation
- [ ] Try to empty trash
- [ ] **Verify**: Confirmation dialog shows warning
- [ ] Cancel
- [ ] **Verify**: No files deleted

#### 8.2 Permanent Delete Confirmation
- [ ] Try to permanently delete a file
- [ ] **Verify**: Confirmation dialog warns "cannot be undone"
- [ ] Cancel
- [ ] **Verify**: File still in trash

#### 8.3 Network Error Handling
- [ ] Turn off backend (stop Docker container)
- [ ] Try to navigate to Trash
- [ ] **Verify**: Error message shows
- [ ] **Verify**: "Try Again" button appears
- [ ] Restart backend
- [ ] Click "Try Again"
- [ ] **Verify**: Trash loads successfully

---

### Test 9: Integration Tests

#### 9.1 End-to-End Flow
- [ ] Upload a new file
- [ ] Add to favorites (click star)
- [ ] **Verify**: Star turns yellow
- [ ] Delete the file
- [ ] **Verify**: File moves to trash
- [ ] Go to Favorites view
- [ ] **Verify**: File no longer in favorites
- [ ] Go to Trash view
- [ ] **Verify**: File is in trash (still shows yellow star if it was favorited)
- [ ] Restore the file
- [ ] **Verify**: File returns to Cloud Drive
- [ ] **Verify**: File is still favorited (yellow star)

#### 9.2 Bulk Operations
- [ ] Select multiple files (click cards/rows)
- [ ] Use bulk delete (if available)
- [ ] **Verify**: All files move to trash
- [ ] Go to Trash
- [ ] **Verify**: All files appear in trash

---

### Test 10: Background Worker (Optional)

#### 10.1 Manual Worker Test
```bash
# Run worker manually
docker exec edge-storage-service python3 -m app.workers.trash_cleanup

# Expected output:
# - Script starts
# - Finds files older than 30 days
# - Deletes them
# - Shows count and freed space
```

#### 10.2 Check Logs
```bash
# Check worker logs
docker exec edge-storage-service cat /var/log/trash_cleanup.log

# Expected: Log of deletions with timestamps
```

#### 10.3 Verify Cleanup
```sql
-- Before running worker: Create old trash file
UPDATE objects
SET is_deleted = TRUE,
    deleted_at = NOW() - INTERVAL '35 days'
WHERE id = '<test-file-id>';

-- Run worker
-- Then verify file is deleted:
SELECT * FROM objects WHERE id = '<test-file-id>';
-- Expected: No rows returned (file deleted)
```

---

## Known Issues to Watch For

### Potential Issues

1. **TrashView not showing**:
   - Check if TrashView.jsx imported correctly in Dashboard.jsx
   - Check console for import errors

2. **Star not visible**:
   - Check if onToggleFavorite prop is passed down
   - Verify Star icon imported from lucide-react

3. **Selection not working**:
   - Check onClick handler on card/row
   - Verify e.stopPropagation() on star and menu

4. **Restore not working**:
   - Check if backend endpoint returns success
   - Verify frontend calls onRefresh after restore

5. **Empty trash not working**:
   - Check confirmation dialog shows
   - Verify API call to /trash/empty

---

## Success Criteria

### Must Have (Critical)
- [x] Frontend compiles without errors ✅
- [x] Backend starts without errors ✅
- [ ] Trash view loads ⚠️ **NEEDS USER TESTING**
- [ ] Files can be deleted (soft delete) ⚠️ **NEEDS USER TESTING**
- [ ] Files can be restored ⚠️ **NEEDS USER TESTING**
- [ ] Star visible in top-left (grid) / first column (list) ⚠️ **NEEDS USER TESTING**
- [ ] No checkbox visible ⚠️ **NEEDS USER TESTING**
- [ ] Click card/row to select ⚠️ **NEEDS USER TESTING**

### Should Have (Important)
- [ ] Empty trash works ⚠️ **NEEDS USER TESTING**
- [ ] Permanent delete works ⚠️ **NEEDS USER TESTING**
- [ ] File layout improved ⚠️ **NEEDS USER TESTING**
- [ ] Dark mode works ⚠️ **NEEDS USER TESTING**
- [ ] Error messages show ⚠️ **NEEDS USER TESTING**

### Nice to Have (Optional)
- [ ] Worker runs successfully
- [ ] Cron job scheduled
- [ ] Activity logging works

---

## Verification Status

### ✅ Code Level Verification (Complete)
- All files created
- No compilation errors
- No import errors
- Services running

### ⚠️ Functional Testing (REQUIRES USER)
- **You must test the UI** to verify:
  - Features work as expected
  - UI looks correct
  - Interactions feel right
  - No runtime errors

---

## Testing Instructions for User

1. **Open Application**: http://localhost:4173/
2. **Login** with your account
3. **Follow Test 1-9** above systematically
4. **Report any issues** you find:
   - Screenshot the error
   - Note what you clicked
   - Check browser console for errors (F12)

---

## Rollback Plan (If Issues Found)

If critical issues are found:

1. **Backend Rollback**:
   ```bash
   git checkout HEAD~1 services/storage-service/app/routers/files.py
   docker compose restart storage-service
   ```

2. **Frontend Rollback**:
   ```bash
   git checkout HEAD~1 frontend-clean/src/components/dashboard/
   ```

3. **Database Rollback**:
   ```sql
   -- Only if absolutely necessary
   ALTER TABLE objects DROP COLUMN is_deleted;
   ALTER TABLE objects DROP COLUMN deleted_at;
   ```

---

## Summary

### ✅ What We're Confident About:
- Code compiles without errors
- Services are running
- Database schema updated
- All files exist in correct locations
- No syntax errors

### ⚠️ What Needs User Testing:
- **Trash functionality works end-to-end**
- **Star visibility and interaction**
- **File selection without checkbox**
- **Layout improvements visible**
- **Dark mode compatibility**

### 🎯 Bottom Line:
**The implementation is COMPLETE from a code perspective, but requires USER TESTING to confirm everything works in the browser.**

---

**Ready to test!** Please go through the checklist above and let me know if you find any issues. 🚀
