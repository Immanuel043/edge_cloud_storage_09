# Final Implementation Steps - Email Verification Auth

## 🎉 STATUS: 85% Complete!

### ✅ What's Been Implemented:

**Backend (100% DONE):**
- ✅ Normal Storage Service: plan_code support, deprecated legacy endpoint
- ✅ ZK Database: migration + model updates
- ✅ ZK Services: verification_service.py, email_service.py
- ✅ ZK Schemas: Pydantic models for all verification endpoints
- ✅ ZK Endpoints: All 4 verification endpoints (init, verify, complete, resend)
- ✅ ZK Config: Mailgun settings added
- ✅ Deprecation: Old endpoints marked deprecated

**Frontend (25% DONE):**
- ✅ VerificationCodeInput component created

---

## 🚧 REMAINING TASKS (15%)

### Task 1: Update AuthPage Component (30 min)

**File:** `frontend-clean/src/components/auth/AuthPage.jsx`

**Steps:**

1. **Add imports** (after line 18):
```javascript
import VerificationCodeInput from './VerificationCodeInput';
```

2. **Add state** (after line 128):
```javascript
const [registrationStep, setRegistrationStep] = useState('form'); // 'form' | 'verify'
const [verificationEmail, setVerificationEmail] = useState('');
const [verificationToken, setVerificationToken] = useState('');
const [pendingFormData, setPendingFormData] = useState(null);
```

3. **Replace handleSubmit** function (lines 201-300) with:
```javascript
const handleSubmit = async (e) => {
  e.preventDefault();
  setError('');
  setFieldErrors({});

  if (lockoutUntil && Date.now() < lockoutUntil) {
    setError(`Too many failed attempts. Please wait ${getLockoutRemaining()} seconds.`);
    return;
  }

  // Validation
  if (!validateEmail(formData.email)) {
    setFieldErrors(prev => ({ ...prev, email: 'Please enter a valid email address' }));
    emailRef.current?.focus();
    return;
  }

  if (authMode === 'login') {
    // LOGIN FLOW (unchanged)
    if (!validatePassword(formData.password)) {
      setFieldErrors(prev => ({ ...prev, password: 'Password must be at least 8 characters' }));
      passwordRef.current?.focus();
      return;
    }

    setLoading(true);
    try {
      if (enableZK) {
        await loginZK(formData.email, formData.password);
      } else {
        await login(formData.email, formData.password, rememberMe);
      }
      setFailedAttempts(0);
      navigate('/');
    } catch (err) {
      const errorMessage = err.message || 'Invalid credentials';
      setError(errorMessage);
      setLoading(false);

      const newFailedAttempts = failedAttempts + 1;
      setFailedAttempts(newFailedAttempts);
      if (newFailedAttempts >= 5) {
        setLockoutUntil(Date.now() + 30000);
        setError('Too many failed attempts. Please wait 30 seconds.');
      }
    }
  } else {
    // REGISTRATION FLOW - NEW 3-STEP PROCESS

    // Validate all fields upfront
    if (formData.username.length < 3) {
      setFieldErrors(prev => ({ ...prev, username: 'Username must be at least 3 characters' }));
      usernameRef.current?.focus();
      return;
    }

    if (!validatePassword(formData.password)) {
      setFieldErrors(prev => ({ ...prev, password: 'Password must be at least 8 characters' }));
      passwordRef.current?.focus();
      return;
    }

    if (passwordStrength && !passwordStrength.isValid) {
      setFieldErrors(prev => ({ ...prev, password: 'Password does not meet strength requirements' }));
      passwordRef.current?.focus();
      return;
    }

    if (formData.password !== formData.confirmPassword) {
      setFieldErrors(prev => ({ ...prev, confirmPassword: 'Passwords do not match' }));
      confirmPasswordRef.current?.focus();
      return;
    }

    setLoading(true);

    try {
      // Step 1: Send verification code
      const initMethod = enableZK ? 'registerZKInit' : 'registerInit';
      await authService[initMethod](formData.email);

      // Success - code sent
      setVerificationEmail(formData.email);
      setPendingFormData(formData);
      setRegistrationStep('verify');
      setLoading(false);

    } catch (err) {
      const errorMessage = err.message || 'Registration failed';
      setError(errorMessage);
      setLoading(false);
    }
  }
};
```

4. **Add verification handlers** (after handleSubmit):
```javascript
const handleVerificationCode = async (code) => {
  setError('');
  setLoading(true);

  try {
    // Call verify endpoint to validate code and get token
    const verifyMethod = enableZK ? 'registerZKVerify' : 'registerVerify';
    const verifyResponse = await authService[verifyMethod](verificationEmail, code);

    if (verifyResponse.verified && verifyResponse.token) {
      setVerificationToken(verifyResponse.token);
      // Auto-proceed to complete registration
      await completeRegistration(verifyResponse.token);
    }
  } catch (err) {
    setError(err.message || 'Invalid verification code');
    setLoading(false);
  }
};

const completeRegistration = async (token) => {
  try {
    // Step 3: Complete registration with verification token
    if (enableZK) {
      // Generate ZK registration data
      const { generateZKRegistrationData } = await import('../../services/zkAuthService');
      const zkData = await generateZKRegistrationData(pendingFormData.password, pendingFormData.email);

      await authService.registerZKComplete(
        pendingFormData.email,
        pendingFormData.username,
        zkData.passwordHash,
        zkData,
        token,
        planFromUrl || 'zk_pro'
      );
      setLoading(false);
      await handleRecoveryPhraseSetup(true);
    } else {
      await authService.registerComplete(
        pendingFormData.email,
        pendingFormData.username,
        pendingFormData.password,
        token,
        planFromUrl || 'normal_free'
      );

      const isPaidPlan = planFromUrl && !planFromUrl.includes('_free');
      if (isPaidPlan) {
        alert('Account created! Please complete payment.');
        navigate('/dashboard?view=billing');
      } else {
        navigate('/');
      }
    }
  } catch (err) {
    setError(err.message || 'Registration failed');
    setLoading(false);
  }
};

const handleResendCode = async () => {
  try {
    const resendMethod = enableZK ? 'resendZKVerificationCode' : 'resendVerificationCode';
    await authService[resendMethod](verificationEmail);
  } catch (err) {
    setError(err.message || 'Failed to resend code');
  }
};

const handleBackToForm = () => {
  setRegistrationStep('form');
  setError('');
};
```

5. **Update render** (find the form section around line 549+):
```javascript
{registrationStep === 'verify' ? (
  // VERIFICATION CODE SCREEN
  <VerificationCodeInput
    email={verificationEmail}
    onVerify={handleVerificationCode}
    onResend={handleResendCode}
    onBack={handleBackToForm}
    darkMode={darkMode}
    loading={loading}
    error={error}
    expiryMinutes={30}
  />
) : (
  // ORIGINAL FORM (keep existing form)
  <form onSubmit={handleSubmit} className="space-y-5">
    {/* Keep all existing form fields */}
  </form>
)}
```

---

### Task 2: Update authService.js (20 min)

**File:** `frontend-clean/src/services/authService.js`

**Add these methods after line 138:**

```javascript
// ==================== Email Verification Registration Flow ====================

/**
 * Step 1: Initialize registration - send verification code
 */
async registerInit(email) {
  await rateLimiter.checkLimit();

  const response = await fetch(`${API_URL}/api/v1/auth/register/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email: sanitizeInput(email) })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to send verification code');
  }

  return await response.json();
}

/**
 * Step 2: Verify email code
 */
async registerVerify(email, code) {
  await rateLimiter.checkLimit();

  const response = await fetch(`${API_URL}/api/v1/auth/register/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      email: sanitizeInput(email),
      verification_code: code
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Invalid verification code');
  }

  return await response.json();
}

/**
 * Step 3: Complete registration with username and password
 */
async registerComplete(email, username, password, verificationToken, planCode = 'normal_free') {
  await rateLimiter.checkLimit();

  const response = await fetch(`${API_URL}/api/v1/auth/register/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      email: sanitizeInput(email),
      username: sanitizeInput(username),
      password,
      verification_token: verificationToken,
      plan_code: planCode
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Registration failed');
  }

  return await response.json();
}

/**
 * Resend verification code
 */
async resendVerificationCode(email) {
  await rateLimiter.checkLimit();

  const response = await fetch(`${API_URL}/api/v1/auth/register/resend-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email: sanitizeInput(email) })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || 'Failed to resend code');
  }

  return await response.json();
}

// ==================== ZK Email Verification Flow ====================

/**
 * Step 1: Initialize ZK registration - send verification code
 */
async registerZKInit(email) {
  await rateLimiter.checkLimit();

  const ZK_API_URL = import.meta.env.VITE_ZK_API_URL || 'http://localhost:8002';
  const response = await fetch(`${ZK_API_URL}/api/v1/zk/register-zk/init`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email: sanitizeInput(email) })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || error.message || 'Failed to send verification code');
  }

  return await response.json();
}

/**
 * Step 2: Verify ZK email code
 */
async registerZKVerify(email, code) {
  await rateLimiter.checkLimit();

  const ZK_API_URL = import.meta.env.VITE_ZK_API_URL || 'http://localhost:8002';
  const response = await fetch(`${ZK_API_URL}/api/v1/zk/register-zk/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      email: sanitizeInput(email),
      verification_code: code
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || error.message || 'Invalid verification code');
  }

  return await response.json();
}

/**
 * Step 3: Complete ZK registration
 */
async registerZKComplete(email, username, passwordHash, zkData, verificationToken, planCode = 'zk_pro') {
  await rateLimiter.checkLimit();

  const ZK_API_URL = import.meta.env.VITE_ZK_API_URL || 'http://localhost:8002';
  const response = await fetch(`${ZK_API_URL}/api/v1/zk/register-zk/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({
      email: sanitizeInput(email),
      username: sanitizeInput(username),
      password_hash: passwordHash,
      encrypted_master_key: zkData.encryptedMasterKey,
      master_key_iv: zkData.masterKeyIV,
      kdf_salt: zkData.kdfSalt,
      kdf_algorithm: zkData.kdfAlgorithm,
      kdf_iterations: zkData.kdfIterations,
      kdf_memory: zkData.kdfMemory,
      kdf_parallelism: zkData.kdfParallelism,
      verification_token: verificationToken,
      plan_code: planCode,
      recovery_encrypted_master_key: zkData.recoveryEncryptedMasterKey,
      recovery_phrase_hash: zkData.recoveryPhraseHash
    })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || error.message || 'Registration failed');
  }

  return await response.json();
}

/**
 * Resend ZK verification code
 */
async resendZKVerificationCode(email) {
  await rateLimiter.checkLimit();

  const ZK_API_URL = import.meta.env.VITE_ZK_API_URL || 'http://localhost:8002';
  const response = await fetch(`${ZK_API_URL}/api/v1/zk/register-zk/resend-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ email: sanitizeInput(email) })
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.detail || error.message || 'Failed to resend code');
  }

  return await response.json();
}
```

---

### Task 3: Update AuthContext (Optional - 10 min)

**File:** `frontend-clean/src/contexts/AuthContext.jsx`

The `register` function may need updating if it's called from other places. Review around line 300-400 to ensure it handles the new flow correctly.

---

## 🚀 DEPLOYMENT & TESTING

### Step 1: Run Database Migration
```bash
cd services/zk-encryption-service
alembic upgrade head
```

### Step 2: Set Environment Variables
Add to your `.env` file:
```env
# Mailgun Configuration
MAILGUN_ENABLED=true
MAILGUN_API_KEY=your-mailgun-api-key
MAILGUN_DOMAIN=your-domain.com
MAILGUN_FROM_EMAIL=noreply@your-domain.com
MAILGUN_FROM_NAME=Edge Cloud Storage

# ZK Service (uses same Mailgun)
ZK_SECRET_KEY=your-zk-secret-key-change-me
```

### Step 3: Rebuild Services
```bash
cd infrastructure
docker-compose down
docker-compose build storage-service zk-encryption-service
docker-compose up -d
```

### Step 4: Test Backend Endpoints

**Test Normal Registration:**
```bash
# Step 1: Init
curl -X POST http://localhost:8001/api/v1/auth/register/init \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com"}'

# Step 2: Verify (check email for code)
curl -X POST http://localhost:8001/api/v1/auth/register/verify \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "verification_code": "123456"}'

# Step 3: Complete (use token from step 2)
curl -X POST http://localhost:8001/api/v1/auth/register/complete \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "username": "testuser", "password": "password123", "verification_token": "TOKEN_HERE"}'
```

**Test ZK Registration:**
```bash
# Step 1: Init
curl -X POST http://localhost:8002/api/v1/zk/register-zk/init \
  -H "Content-Type: application/json" \
  -d '{"email": "zktest@example.com"}'

# Check Mailgun dashboard for sent emails
```

### Step 5: Test Frontend
```bash
cd frontend-clean
npm run dev
```

Navigate to:
- Normal: `http://localhost:5173/auth`
- ZK: `http://localhost:5173/auth?service=zk`

**Test Checklist:**
- [ ] Registration form shows all fields
- [ ] After submit, verification screen appears
- [ ] Can paste 6-digit code
- [ ] Countdown timer shows 30 minutes
- [ ] Resend button has 60s cooldown
- [ ] Error messages display correctly
- [ ] Can enter code manually
- [ ] Redirects to dashboard after completion
- [ ] Can login with newly created account

---

## 📋 SUMMARY

**Backend:** ✅ 100% Complete (All endpoints implemented)
**Frontend:** ✅ 25% Complete (Component created, need to integrate)

**Remaining work:** ~1 hour
- Update AuthPage component (30 min)
- Update authService.js (20 min)
- Test end-to-end (10 min)

**Files to modify:**
1. `frontend-clean/src/components/auth/AuthPage.jsx`
2. `frontend-clean/src/services/authService.js`

After completing these 2 files, the entire implementation will be done!
