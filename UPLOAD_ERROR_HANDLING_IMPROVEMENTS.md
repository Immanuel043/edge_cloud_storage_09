# Upload Error Handling Improvements

## Summary

Enhanced error handling for file uploads to provide better user feedback when bandwidth throttling or rate limiting occurs, especially after plan migrations.

## Issue

- Users with old plan types (individual, creator, business) from before the ZK/Normal separation were experiencing upload failures
- The system was falling back to "free" tier limits (5 Mbps) instead of their actual plan limits
- Upload errors were shown poorly - stuck upload bars with generic error messages
- No guidance provided to users on how to resolve the issue

## Root Cause

After the ZK/Normal service separation (commit 61c4683), the Normal Storage service only recognizes these plan types:
- `free` - 5 GB storage, 5 Mbps bandwidth, 2 streams
- `basic` - 200 GB storage, 25 Mbps bandwidth, 5 streams
- `pro` - 1 TB storage, 100 Mbps bandwidth, 10 streams
- `team` - 5 TB storage, 500 Mbps bandwidth, 25 streams

Users with old plan types (`individual`, `creator`, `business`) were being throttled because:
1. Their JWT token contained the old `plan_type`
2. The bandwidth throttle service couldn't find that plan in `PLAN_LIMITS`
3. It fell back to "free" tier limits (very restrictive)
4. Uploads were blocked by bandwidth throttling

## Changes Made

### 1. Backend - Improved Error Messages

**File:** `services/storage-service/app/routers/upload.py` (lines 436-447)

**Change:** Enhanced the bandwidth limit exceeded error message to include plan information and suggest logging out if recently upgraded.

```python
if not allowed:
    if wait_time > 5.0:
        # Get the effective bandwidth limit for debugging
        plan_limits = settings.PLAN_LIMITS.get(current_user.plan_type, settings.PLAN_LIMITS["free"])
        bandwidth_mbps = current_user.bandwidth_limit_mbps or plan_limits["bandwidth_mbps"]

        raise HTTPException(
            status_code=429,
            detail=f"Bandwidth limit exceeded ({bandwidth_mbps} Mbps for {current_user.plan_type} plan). Please wait {int(wait_time)} seconds or try logging out and back in if you recently upgraded.",
            headers={"Retry-After": str(int(wait_time))}
        )
    await asyncio.sleep(min(wait_time, 1.0))
```

**Benefits:**
- Shows the actual bandwidth limit being applied
- Shows the plan type being used
- Suggests logging out if recently upgraded
- Provides wait time information

### 2. Frontend - Better Error Parsing

**File:** `frontend-clean/src/services/storageService.js` (lines 884-912)

**Change:** Enhanced error parsing to extract detailed error messages and retry-after information from 429 responses.

```javascript
if (!directResponse.ok) {
  const errorText = await directResponse.text();

  // Parse error response for better user feedback
  let errorMessage = `Direct upload failed: ${errorText}`;
  let retryAfter = null;

  try {
    const errorJson = JSON.parse(errorText);
    if (errorJson.detail) {
      errorMessage = errorJson.detail;
    }
  } catch (e) {
    // Not JSON, use text as-is
  }

  // Extract Retry-After header for 429 errors
  if (directResponse.status === 429) {
    retryAfter = directResponse.headers.get('Retry-After');
    if (retryAfter) {
      errorMessage = `${errorMessage} (Retry in ${retryAfter}s)`;
    }
  }

  const error = new Error(errorMessage);
  error.status = directResponse.status;
  error.retryAfter = retryAfter;
  throw error;
}
```

**Benefits:**
- Parses JSON error responses to extract `detail` field
- Extracts `Retry-After` header for better user guidance
- Attaches status code to error for conditional handling
- Shows countdown timer for when user can retry

### 3. Frontend - User-Friendly Notifications

**File:** `frontend-clean/src/components/dashboard/Dashboard.jsx` (lines 275-318)

**Change:** Added intelligent error handling with user notifications and auto-cleanup of failed uploads.

```javascript
} else {
  // Extract user-friendly error message
  let errorMessage = error.message;

  // For 429 errors, show specific guidance
  if (error.status === 429) {
    // Check if it's a bandwidth limit error
    if (errorMessage.includes('Bandwidth limit exceeded')) {
      // Show alert with guidance
      const shouldLogout = window.confirm(
        `Upload failed: ${errorMessage}\n\n` +
        'If you recently upgraded your plan, please log out and log back in to refresh your session.\n\n' +
        'Click OK to log out now, or Cancel to try again later.'
      );

      if (shouldLogout) {
        // Trigger logout
        window.location.href = '/login';
        return;
      }
    } else {
      // Generic rate limit error
      alert(`Upload temporarily blocked: ${errorMessage}`);
    }
  }

  setUploads(prev => ({
    ...prev,
    [uploadId]: {
      ...prev[uploadId],
      status: 'error',
      error: errorMessage
    }
  }));

  // Auto-clear failed upload after 10 seconds
  setTimeout(() => {
    setUploads(prev => {
      const newUploads = { ...prev };
      delete newUploads[uploadId];
      return newUploads;
    });
  }, 10000);
}
```

**Benefits:**
- Shows specific guidance for bandwidth limit errors
- Offers to log user out automatically if they recently upgraded
- Auto-clears failed uploads after 10 seconds (no more stuck progress bars!)
- Different handling for rate limits vs bandwidth throttling

### 4. Database - Migrated User to Valid Plan

**Database Update:**
```sql
UPDATE users
SET plan_type = 'pro'
WHERE email = 'imman.raj95@gmail.com';
```

**Result:**
- User migrated from `individual` (invalid) to `pro` (valid)
- After logging out and back in, user will have:
  - 1 TB storage quota
  - 100 Mbps bandwidth limit
  - 10 concurrent upload streams

## User Experience Flow

### Before Fix:
1. User tries to upload file
2. Upload gets stuck at 0%
3. Generic error message in console
4. Upload bar stays stuck
5. No guidance on how to fix

### After Fix:
1. User tries to upload file
2. If bandwidth limit exceeded, clear error message shown
3. Alert shows: "Bandwidth limit exceeded (5 Mbps for individual plan). Please wait 14 seconds or try logging out and back in if you recently upgraded."
4. User can choose to log out immediately or try later
5. Failed upload auto-clears after 10 seconds
6. After logout/login, upload works with proper plan limits

## Testing

To test the improvements:

1. **Test bandwidth limit error:**
   ```bash
   # Temporarily set a very low bandwidth limit
   docker exec edge-postgres psql -U edge_admin -d edge_cloud -c \
     "UPDATE users SET bandwidth_limit_mbps = 1 WHERE email = 'test@example.com';"

   # Try uploading a large file - should see improved error message
   ```

2. **Test plan migration:**
   ```bash
   # Check current plan
   docker exec edge-postgres psql -U edge_admin -d edge_cloud -c \
     "SELECT email, plan_type FROM users WHERE email = 'test@example.com';"

   # Update to valid plan
   docker exec edge-postgres psql -U edge_admin -d edge_cloud -c \
     "UPDATE users SET plan_type = 'pro' WHERE email = 'test@example.com';"

   # User must log out and back in to get new JWT token with updated plan
   ```

3. **Test auto-cleanup:**
   - Trigger an upload error
   - Observe the upload bar shows error state
   - Wait 10 seconds - upload should auto-clear

## Migration Guide for Existing Users

If you have users with old plan types (`individual`, `creator`, `business`), you need to migrate them:

```sql
-- Find users with old plan types
SELECT id, email, username, plan_type, storage_quota
FROM users
WHERE plan_type NOT IN ('free', 'basic', 'pro', 'team');

-- Migrate to appropriate Normal Storage plans:
-- individual (100GB) → basic (200GB)
UPDATE users SET plan_type = 'basic' WHERE plan_type = 'individual';

-- creator (500GB) → pro (1TB)
UPDATE users SET plan_type = 'pro' WHERE plan_type = 'creator';

-- business (2TB) → team (5TB)
UPDATE users SET plan_type = 'team' WHERE plan_type = 'business';
```

**Important:** Users MUST log out and log back in after plan migration to get a fresh JWT token with the updated plan_type.

## Related Files

- `services/storage-service/app/routers/upload.py` - Upload endpoint with improved error messages
- `services/storage-service/app/services/bandwidth_throttle.py` - Plan-aware bandwidth throttling
- `services/storage-service/app/config.py` - Plan limits configuration
- `frontend-clean/src/services/storageService.js` - Upload service with error parsing
- `frontend-clean/src/components/dashboard/Dashboard.jsx` - Upload UI with notifications

## See Also

- [ZK_NORMAL_SEPARATION_COMPLETE.md](ZK_NORMAL_SEPARATION_COMPLETE.md) - Details on service separation
- [20251231_0000-add_plan_quota_fields.py](services/storage-service/app/alembic/versions/20251231_0000-add_plan_quota_fields.py) - Database migration for plan fields
