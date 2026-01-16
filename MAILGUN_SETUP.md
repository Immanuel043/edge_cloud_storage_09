# Mailgun Setup Guide for Email Verification

## Step 1: Add Your Mailgun Credentials

You have **two options** to configure Mailgun:

### Option A: Using .env file (Recommended)

1. Create or edit the file `infrastructure/.env`:

```bash
cd infrastructure
nano .env  # or use your favorite editor
```

2. Add these lines with **your actual Mailgun credentials**:

```env
# Mailgun Configuration
MAILGUN_ENABLED=true
MAILGUN_API_KEY=your-actual-mailgun-api-key
MAILGUN_DOMAIN=mg.yourdomain.com
MAILGUN_FROM_EMAIL=noreply@yourdomain.com
MAILGUN_FROM_NAME=Edge Cloud Storage
```

3. Save the file

### Option B: Export as environment variables (Alternative)

```bash
export MAILGUN_ENABLED=true
export MAILGUN_API_KEY="your-actual-mailgun-api-key"
export MAILGUN_DOMAIN="mg.yourdomain.com"
export MAILGUN_FROM_EMAIL="noreply@yourdomain.com"
export MAILGUN_FROM_NAME="Edge Cloud Storage"
```

---

## Step 2: Find Your Mailgun Credentials

### Where to find your Mailgun API Key:

1. Go to https://app.mailgun.com/
2. Log in to your account
3. Click on **"Sending"** → **"Domain Settings"**
4. Select your domain
5. Click on **"API Keys"** tab
6. Copy the **Private API key** (starts with `key-...`)

### Your Mailgun Domain:

- If you added a custom domain: `mg.yourdomain.com` (or whatever subdomain you chose)
- If using Mailgun sandbox: `sandboxXXXXXXXXXXXXXXXXXXXXXXXXXXXX.mailgun.org`

**Note:** Sandbox domains can only send to authorized recipients. For production, use a verified custom domain.

---

## Step 3: Rebuild Services

After adding your Mailgun credentials:

```bash
cd infrastructure
docker-compose down
docker-compose build storage-service zk-encryption-service
docker-compose up -d
```

---

## Step 4: Verify Configuration

### Test the backend endpoints:

**Test Normal Storage Service:**
```bash
curl -X POST http://localhost:8001/api/v1/auth/register/init \
  -H "Content-Type: application/json" \
  -d '{"email": "your-test-email@example.com"}'
```

**Test ZK Service:**
```bash
curl -X POST http://localhost:8002/api/v1/zk/register-zk/init \
  -H "Content-Type: application/json" \
  -d '{"email": "your-test-email@example.com"}'
```

Expected response:
```json
{
  "message": "Verification code sent to your email",
  "email": "your-test-email@example.com"
}
```

### Check Mailgun Logs:

1. Go to https://app.mailgun.com/
2. Click **"Sending"** → **"Logs"**
3. Look for your sent emails
4. Check delivery status

---

## Step 5: Check Docker Logs for Errors

If emails aren't sending:

```bash
# Check storage service logs
docker-compose logs -f storage-service | grep -i mail

# Check ZK service logs
docker-compose logs -f zk-encryption-service | grep -i mail
```

Common issues:
- **"Invalid API key"** - Check your MAILGUN_API_KEY
- **"Domain not verified"** - Verify your domain in Mailgun dashboard
- **"Recipient not authorized"** - Sandbox domains need authorized recipients

---

## Configuration Reference

### Environment Variables Set:

Both services now have these variables configured in `docker-compose.yml`:

```yaml
MAILGUN_ENABLED: ${MAILGUN_ENABLED:-true}
MAILGUN_API_KEY: ${MAILGUN_API_KEY:-}
MAILGUN_DOMAIN: ${MAILGUN_DOMAIN:-}
MAILGUN_FROM_EMAIL: ${MAILGUN_FROM_EMAIL:-noreply@yourdomain.com}
MAILGUN_FROM_NAME: ${MAILGUN_FROM_NAME:-Edge Cloud Storage}
```

### Files Modified:

1. ✅ `infrastructure/docker-compose.yml` - Added Mailgun env vars to both services
2. ✅ `infrastructure/.env.example` - Added Mailgun template

---

## Example .env File

Your `infrastructure/.env` should look like this:

```env
# Mailgun Configuration
MAILGUN_ENABLED=true
MAILGUN_API_KEY=key-1234567890abcdef1234567890abcdef
MAILGUN_DOMAIN=mg.yourdomain.com
MAILGUN_FROM_EMAIL=noreply@yourdomain.com
MAILGUN_FROM_NAME=Edge Cloud Storage

# Other configs...
SECRET_KEY=your-secret-key-here
ZK_SECRET_KEY=zk-secret-key-change-in-production
```

---

## Testing the Complete Flow

1. **Start services:**
   ```bash
   cd infrastructure
   docker-compose up -d
   ```

2. **Start frontend:**
   ```bash
   cd frontend-clean
   npm run dev
   ```

3. **Test Normal Registration:**
   - Go to: `http://localhost:5173/auth?plan=normal_free`
   - Fill in registration form
   - Click "Create Account"
   - Check your email for 6-digit code
   - Enter code in verification screen
   - Should redirect to dashboard

4. **Test ZK Registration:**
   - Go to: `http://localhost:5173/auth?service=zk&plan=zk_pro`
   - Enable "Zero-Knowledge Encryption"
   - Fill in registration form
   - Click "Create Account"
   - Check email for code
   - Enter code
   - Should show recovery phrase setup

---

## Troubleshooting

### Problem: "Failed to send verification code"

**Solution 1:** Check API key format
```bash
# API key should start with "key-" followed by 32 characters
echo $MAILGUN_API_KEY
```

**Solution 2:** Check domain verification
- Go to Mailgun dashboard → Domain Settings
- Ensure domain status is "Active" (green)

**Solution 3:** Check Docker logs
```bash
docker-compose logs storage-service | tail -50
docker-compose logs zk-encryption-service | tail -50
```

### Problem: Emails not received

**Solution 1:** Check spam/junk folder

**Solution 2:** Verify Mailgun logs (see Step 4 above)

**Solution 3:** If using sandbox domain, authorize recipient:
- Mailgun Dashboard → Sending → Domain Settings → Authorized Recipients
- Add your test email address

### Problem: "Invalid domain"

**Solution:** Ensure domain format is correct:
- ✅ Correct: `mg.yourdomain.com`
- ❌ Wrong: `https://mg.yourdomain.com`
- ❌ Wrong: `mg.yourdomain.com/`

---

## Production Checklist

Before going live:

- [ ] Use a verified custom domain (not sandbox)
- [ ] Set `MAILGUN_FROM_EMAIL` to a real email on your domain
- [ ] Test email delivery to multiple providers (Gmail, Outlook, Yahoo)
- [ ] Check SPF, DKIM, DMARC records are configured
- [ ] Monitor Mailgun logs for bounce rates
- [ ] Set up email templates with your branding (optional)

---

## Support

If you continue to have issues:

1. Check Mailgun API status: https://status.mailgun.com/
2. Review Mailgun documentation: https://documentation.mailgun.com/
3. Contact Mailgun support from your dashboard

---

**Last Updated:** 2026-01-10
