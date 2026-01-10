# Mailgun Setup Guide for edgevaultcloud.com

This guide walks you through the manual steps required to complete the Mailgun email service setup.

## ✅ Automated Steps (Already Complete)

- [x] Created `infrastructure/.env` file with Mailgun configuration template
- [x] Configured environment variables structure

## 📋 Manual Steps (Follow in Order)

### Step 1: Create Mailgun Account and Add Domain

1. **Create Account:**
   - Go to https://signup.mailgun.com
   - Sign up with your email
   - Verify your email address

2. **Add Domain:**
   - Navigate to **Sending → Domains** in Mailgun dashboard
   - Click **"Add New Domain"**
   - **IMPORTANT:** Enter `mg.edgevaultcloud.com` (NOT the root domain)
   - Choose domain type: **Domain**
   - Choose region: **US** (or EU if you prefer)
   - Click **Add Domain**

3. **Mailgun will generate DNS records** - Keep this page open, you'll need these records in the next step.

---

### Step 2: Add DNS Records to Cloudflare

**⚠️ CRITICAL:** Copy DNS records EXACTLY as Mailgun provides them. Do NOT invent or modify record names.

1. **Log into Cloudflare:**
   - Go to https://dash.cloudflare.com
   - Select your domain: `edgevaultcloud.com`

2. **Navigate to DNS:**
   - Click **DNS** in the left sidebar
   - Click **Records**

3. **Add Each Record from Mailgun:**
   
   For each record Mailgun provides:
   - Click **"Add record"**
   - **Type:** Select the type (TXT, CNAME, or MX)
   - **Name:** Copy the EXACT host name from Mailgun (e.g., `s1._domainkey.mg`)
   - **Content/Value:** Copy the EXACT value from Mailgun
   - **Proxy status:** Click the cloud icon to set it to **DNS-only (gray cloud)** ⚠️ Do NOT proxy Mailgun records
   - Click **Save**

   **Typical records you'll add:**
   - SPF (TXT): Host `mg`, Value `v=spf1 include:mailgun.org ~all`
   - DKIM (TXT): Hosts like `s1._domainkey.mg` and `s2._domainkey.mg` (exact selectors from Mailgun)
   - Tracking (CNAME): Host `email.mg`, Target `mailgun.org`
   - MX (Optional): Host `mg`, Priority 10, Target `mxa.mailgun.org` and `mxb.mailgun.org`

4. **Wait for DNS Propagation:**
   - DNS changes typically propagate in 5-20 minutes on Cloudflare
   - You can check propagation status in Mailgun dashboard

---

### Step 3: Verify Domain in Mailgun

1. **Return to Mailgun Dashboard:**
   - Go back to **Sending → Domains**
   - Find your domain `mg.edgevaultcloud.com`
   - Click **"Verify DNS Settings"** or **"Check DNS"**

2. **Wait for Verification:**
   - All records should show green checkmarks ✅
   - Verification usually completes in 5-20 minutes
   - If some records show as failed, double-check you copied them exactly from Mailgun

3. **Get Your API Key:**
   - Once verified, go to **Settings → API Keys**
   - Copy your **Private API key** (starts with `key-`)
   - You'll need this for the `.env` file

---

### Step 4: Add DMARC Record (Recommended)

Add a DMARC record to protect your domain's email reputation:

1. **In Cloudflare DNS:**
   - Click **"Add record"**
   - **Type:** TXT
   - **Name:** `_dmarc`
   - **Content:** `v=DMARC1; p=none; rua=mailto:dmarc@edgevaultcloud.com`
   - **Proxy:** DNS-only (gray cloud)
   - Click **Save**

2. **Note:** Start with `p=none` (monitoring only). After confirming everything works, you can tighten to `p=quarantine` then `p=reject`.

---

### Step 5: Update .env File with API Key

1. **Open the .env file:**
   ```bash
   nano infrastructure/.env
   # or use your preferred editor
   ```

2. **Replace the placeholder:**
   - Find the line: `MAILGUN_API_KEY=key-xxxxxxxxxxxx`
   - Replace `key-xxxxxxxxxxxx` with your actual Mailgun API key (from Step 3)

3. **Save the file**

---

### Step 6: Test Email Sending

1. **Start the Storage Service:**
   ```bash
   cd infrastructure
   docker-compose up -d storage-service
   ```

2. **Test Registration Flow:**
   - Navigate to your registration page
   - Enter an email address
   - Trigger the email verification flow
   - Check your email inbox for the verification code

3. **Verify in Mailgun Dashboard:**
   - Go to **Sending → Logs** in Mailgun
   - You should see the email delivery attempt
   - Check that status is "delivered" or "accepted"

4. **Check Email Headers:**
   - In your email client, view the email headers
   - Verify:
     - ✅ SPF = PASS
     - ✅ DKIM = PASS
     - ✅ DMARC = PASS

---

## Troubleshooting

### DNS Records Not Verifying

- **Double-check:** Did you copy the exact host names and values from Mailgun?
- **Proxy Status:** Are all Mailgun DNS records set to DNS-only (gray cloud) in Cloudflare?
- **Wait Time:** DNS propagation can take up to 48 hours, but usually completes in 5-20 minutes on Cloudflare

### Emails Not Sending

- **Check API Key:** Is `MAILGUN_API_KEY` correctly set in `.env`?
- **Check Domain:** Is `MAILGUN_DOMAIN=mg.edgevaultcloud.com` (subdomain, not root)?
- **Check Logs:** Look at Mailgun dashboard → Logs for error messages
- **Check Service Logs:** `docker-compose logs storage-service` to see application errors

### SPF/DKIM/DMARC Failures

- **SPF:** Verify the SPF TXT record is correctly added for `mg` subdomain
- **DKIM:** Ensure both DKIM records (`s1._domainkey.mg` and `s2._domainkey.mg`) are added
- **DMARC:** Check that the `_dmarc` record is added to the root domain

---

## Quick Reference

**Mailgun Domain:** `mg.edgevaultcloud.com`  
**From Email:** `noreply@edgevaultcloud.com`  
**API URL:** `https://api.mailgun.net/v3` (US) or `https://api.eu.mailgun.net/v3` (EU)  
**DMARC Email:** `dmarc@edgevaultcloud.com`

---

## Next Steps After Setup

Once email verification is working:
1. Monitor Mailgun logs for delivery issues
2. Gradually tighten DMARC policy (`p=quarantine` → `p=reject`)
3. Set up email alerts for DMARC reports
4. Monitor email reputation in Mailgun dashboard

