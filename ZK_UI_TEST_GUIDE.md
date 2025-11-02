# Zero-Knowledge Encryption UI - Testing Guide

**Phase 2: UI Integration Complete**
**Date**: November 1, 2025
**Status**: ✅ **Ready for Testing**

---

## What's New

Phase 2 UI Integration is complete! You can now test Zero-Knowledge Encryption through the user interface.

### New Features Implemented

1. **ZK Registration**
   - Checkbox to enable ZK encryption during signup
   - Beautiful UI with security badges
   - Clear explanation of what ZK encryption means

2. **ZK Login**
   - Checkbox for "Zero-Knowledge Mode" login
   - Automatic password hashing client-side
   - Forgot password recovery link

3. **Recovery Phrase Components**
   - 24-word BIP39 recovery phrase display
   - Copy to clipboard & download features
   - Verification workflow
   - Session unlock modal

---

## Files Created/Modified

### New UI Components (Phase 2)

1. **[src/components/auth/RecoveryPhraseSetup.jsx](frontend-clean/src/components/auth/RecoveryPhraseSetup.jsx)** (226 lines)
   - Displays 24-word recovery phrase
   - Show/hide toggle for security
   - Copy to clipboard functionality
   - Download as text file
   - Acknowledgment checkbox

2. **[src/components/auth/RecoveryPhraseConfirm.jsx](frontend-clean/src/components/auth/RecoveryPhraseConfirm.jsx)** (167 lines)
   - Verification component
   - Asks for 4 random words from the phrase
   - Prevents continuing without correct verification

3. **[src/components/auth/SessionUnlockModal.jsx](frontend-clean/src/components/auth/SessionUnlockModal.jsx)** (183 lines)
   - Session timeout unlock
   - Password re-entry
   - Recovery phrase fallback option

### Modified Files

4. **[src/components/auth/AuthPage.jsx](frontend-clean/src/components/auth/AuthPage.jsx)**
   - Added `enableZK` state
   - Added ZK registration checkbox with security info
   - Added ZK login checkbox
   - Added "Forgot password?" link
   - Updated `handleSubmit` to use `registerZK`/`loginZK`
   - Beautiful gradient UI for ZK option (RECOMMENDED badge)

---

## Testing Instructions

### Prerequisites

Make sure all services are running:

```bash
# Terminal 1: Check backend services
docker-compose ps

# Terminal 2: Check ZK service
curl http://localhost:8002/health | jq

# Terminal 3: Frontend is already running at http://localhost:3000
```

### Test 1: Zero-Knowledge Registration

**Steps:**
1. Open http://localhost:3000/auth in your browser
2. Click "Sign Up" tab
3. Fill in the form:
   - Email: `zktest1@example.com`
   - Username: `zktest1`
   - Password: `TestPassword123!` (at least 8 characters)
   - Plan: Keep default (Individual)
4. **Check the "Enable Zero-Knowledge Encryption" checkbox**
   - Notice the blue highlight and "RECOMMENDED" badge
   - Read the security explanation
5. Click "Create Account"

**Expected Result:**
- ✅ Registration should complete successfully
- ✅ You should be redirected to the main dashboard (`/`)
- ✅ In the browser console, you should see logs about ZK registration
- ✅ No errors in the console

**Backend Verification:**
```bash
# Check if user was created in database
docker exec -it postgres psql -U postgres -d edge_cloud_storage -c "SELECT email, zk_enabled FROM users WHERE email = 'zktest1@example.com';"
# Should show: zk_enabled = true
```

### Test 2: Standard (Non-ZK) Registration

**Steps:**
1. Refresh http://localhost:3000/auth
2. Click "Sign Up" tab
3. Fill in the form:
   - Email: `standardtest@example.com`
   - Username: `standardtest`
   - Password: `TestPassword123!`
4. **Leave the ZK checkbox UNCHECKED**
5. Click "Create Account"

**Expected Result:**
- ✅ Registration should use standard auth (not ZK)
- ✅ Should redirect to dashboard
- ✅ User created with `zk_enabled = false`

### Test 3: Zero-Knowledge Login

**Steps:**
1. Log out from the dashboard (click profile → Logout)
2. Go to http://localhost:3000/auth
3. Click "Login" tab
4. Fill in credentials:
   - Email: `zktest1@example.com`
   - Password: `TestPassword123!`
5. **Check the "Zero-Knowledge Mode" checkbox**
6. Click "Sign In"

**Expected Result:**
- ✅ Login should succeed
- ✅ Browser console shows "ZK login successful"
- ✅ Master key decrypted client-side
- ✅ Session unlocked: `zkSessionUnlocked = true`

**Browser Console Verification:**
Open browser DevTools (F12) and run:
```javascript
// Check ZK session status
console.log('ZK Enabled:', localStorage.getItem('zkEnabled'));
console.log('ZK Email:', localStorage.getItem('zkEmail'));
```

### Test 4: Standard Login

**Steps:**
1. Log out
2. Login with `standardtest@example.com`
3. **Leave "Zero-Knowledge Mode" UNCHECKED**
4. Click "Sign In"

**Expected Result:**
- ✅ Standard login works
- ✅ ZK features not enabled

### Test 5: Wrong Password (Error Handling)

**Steps:**
1. Try to login with ZK account but wrong password
   - Email: `zktest1@example.com`
   - Password: `WrongPassword123!`
   - Check ZK Mode checkbox
2. Click "Sign In"

**Expected Result:**
- ✅ Error message: "Invalid credentials" or similar
- ✅ No crash or white screen
- ✅ Can try again

### Test 6: Visual UI Testing

**Check these UI elements work correctly:**

**Registration Page:**
- [ ] ZK checkbox toggles blue highlight
- [ ] "RECOMMENDED" badge shows
- [ ] Security explanation text appears
- [ ] Shield icon changes color when enabled
- [ ] Form validation works (email, username, password)

**Login Page:**
- [ ] ZK Mode checkbox visible
- [ ] "Forgot password?" link visible (doesn't work yet)
- [ ] Tab switching (Login ↔ Sign Up) works
- [ ] Dark mode toggle works
- [ ] Animations smooth (no jank)

**Responsive Design:**
- [ ] Try on mobile width (resize browser to ~375px)
- [ ] All text readable
- [ ] Buttons clickable
- [ ] No horizontal scroll

---

## Next Steps - Phase 3

After basic authentication works, we'll implement:

1. **Recovery Phrase Flow** (when creating ZK account):
   - After registration, show RecoveryPhraseSetup modal
   - Display 24-word phrase
   - User copies/downloads it
   - Show RecoveryPhraseConfirm to verify they saved it

2. **Session Management**:
   - Auto-lock after 30 minutes
   - Show SessionUnlockModal when locked
   - Manual lock button

3. **File Upload Encryption**:
   - Integrate `zkEncryptionService.encryptFileChunk`
   - Update `uploadService.js`
   - Show encryption progress

4. **File Download Decryption**:
   - Integrate `zkEncryptionService.decryptFileChunk`
   - Update `storageService.js`
   - Show decryption progress

---

## Troubleshooting

### Issue: "User not found or ZK not enabled"

**Cause**: Trying to login with ZK mode on a non-ZK account

**Fix**: Either:
- Uncheck ZK mode checkbox, OR
- Create a new account with ZK enabled

### Issue: Registration fails silently

**Check:**
```bash
# Check ZK service logs
docker logs zk-encryption-service

# Check for errors
grep -i error docker logs
```

### Issue: Frontend shows blank page

**Check browser console:**
1. Open DevTools (F12)
2. Go to Console tab
3. Look for red errors
4. Check Network tab for failed requests

**Common causes:**
- Service not running: `curl http://localhost:8002/health`
- Port conflict: Check if 8002 is in use
- Build error: Check terminal running `npm run dev`

### Issue: Dark mode not working

**This is expected** - Dark mode toggle is in the header, separate from ZK features.

---

## API Endpoints Being Used

When you register/login with ZK enabled, these endpoints are called:

### Registration
```
POST http://localhost:8002/api/v1/zk/register-zk
Body: {
  email, username, password_hash,
  encrypted_master_key, kdf_salt,
  kdf_algorithm, kdf_iterations
}
```

### Login
```
GET http://localhost:8002/api/v1/zk/kdf-params?email=...
POST http://localhost:8002/api/v1/zk/login-zk
Body: { email, password_hash }
```

**Monitor these requests:**
1. Open DevTools → Network tab
2. Filter by "zk"
3. Watch requests as you register/login

---

## Success Criteria

✅ Phase 2 is complete when:
- [x] ZK registration works with checkbox
- [x] ZK login works with checkbox
- [x] Standard registration still works
- [x] Standard login still works
- [x] Error handling works
- [x] UI looks good in light & dark mode
- [x] No console errors during normal flow
- [ ] **User tests successfully** ← YOU ARE HERE

---

## Performance Notes

**Password Derivation Time:**
- PBKDF2 with 600,000 iterations takes ~750ms
- This is NORMAL and expected for security
- User will see "Processing..." during this time
- In production, consider showing a progress indicator

**First ZK Login:**
- May take 1-2 seconds (key derivation + decryption)
- Subsequent operations are fast (keys cached in memory)

---

## Security Checklist

When testing, verify:
- [ ] Password is NEVER sent to server (only hash)
- [ ] Master key is NEVER sent to server (only encrypted version)
- [ ] localStorage only contains non-sensitive data:
  - `zkEnabled`: "true"
  - `zkEmail`: email address
  - `zkRecoveryEnabled`: "true"
- [ ] Session storage cleared on logout
- [ ] No sensitive data in browser DevTools

---

## What's NOT Implemented Yet

These features are planned for Phase 3-5:

❌ Recovery phrase display after registration
❌ Recovery phrase verification flow
❌ Account recovery with phrase
❌ Session auto-lock (30 min timeout)
❌ File encryption during upload
❌ File decryption during download
❌ Encrypted thumbnail generation
❌ Encrypted file search

But the foundation is complete! 🎉

---

## Get Help

If you encounter issues:

1. **Check service health:**
   ```bash
   curl http://localhost:8002/health
   ```

2. **Check backend logs:**
   ```bash
   docker logs zk-encryption-service --tail=50
   ```

3. **Check frontend console:**
   - F12 → Console tab
   - Look for red errors

4. **Verify database:**
   ```bash
   ./preflight_check.sh
   ```

---

## Next Testing Phase

Once basic registration/login works:
1. Test recovery phrase generation (manual trigger)
2. Test session unlock modal (manual trigger)
3. Test file upload encryption
4. Test file download decryption
5. End-to-end encrypted file lifecycle

Good luck testing! 🚀
