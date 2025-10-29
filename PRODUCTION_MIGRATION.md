# Production Migration Guide - HTTP/2 with Let's Encrypt

## Overview

This guide walks you through migrating from **development (self-signed certificate)** to **production (Let's Encrypt certificate)** with zero downtime.

**Current State:** Development with HTTP/2 and self-signed SSL
**Target State:** Production with HTTP/2 and Let's Encrypt SSL

---

## Prerequisites

Before starting, ensure you have:

- [ ] **Domain name** purchased and registered
- [ ] **DNS configured** (A record pointing to your server IP)
- [ ] **Port 80 and 443** accessible from internet
- [ ] **Docker and docker-compose** installed and running
- [ ] **Server running** with current HTTP/2 setup

---

## Part 1: Domain Setup

### Step 1: Purchase Domain Name

**Recommended Registrars:**

| Registrar | Price/Year | Features | Link |
|-----------|------------|----------|------|
| **Namecheap** | $8-12 | Free privacy protection, good UI | [namecheap.com](https://www.namecheap.com) |
| **Google Domains** | $12 | GCP integration, simple interface | [domains.google.com](https://domains.google.com) |
| **Cloudflare** | $9 | Best DNS, free CDN | [cloudflare.com](https://www.cloudflare.com/products/registrar/) |
| **Porkbun** | $6-10 | Cheapest, good features | [porkbun.com](https://porkbun.com) |

**Domain Extension Recommendations:**
- ✅ `.com` - Best for credibility and recognition
- ✅ `.io` - Popular for tech startups and SaaS
- ✅ `.app` - Requires HTTPS by default (perfect for your use case!)
- ❌ `.xyz`, `.tk` - Cheap but less professional

### Step 2: Configure DNS

After purchasing your domain, add DNS records:

```
Type: A
Host: @
Value: YOUR_SERVER_IP_ADDRESS
TTL: 300 (5 minutes)

Type: A
Host: www
Value: YOUR_SERVER_IP_ADDRESS
TTL: 300
```

**Example:**
```
A Record:   mydomain.com      → 203.0.113.42
A Record:   www.mydomain.com  → 203.0.113.42
```

### Step 3: Verify DNS Propagation

Wait 5-30 minutes for DNS to propagate, then test:

```bash
# Check DNS resolution
dig +short yourdomain.com

# Expected output: YOUR_SERVER_IP_ADDRESS

# Check from multiple locations
nslookup yourdomain.com 8.8.8.8  # Google DNS
nslookup yourdomain.com 1.1.1.1  # Cloudflare DNS
```

**Online tools:**
- https://www.whatsmydns.net
- https://dnschecker.org

---

## Part 2: Let's Encrypt Certificate

### Step 1: Ensure Ports are Open

Let's Encrypt needs port 80 for validation:

```bash
# Check if port 80 is accessible
curl -I http://yourdomain.com

# Check firewall (Ubuntu/Debian)
sudo ufw status
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Check firewall (CentOS/RHEL)
sudo firewall-cmd --list-all
sudo firewall-cmd --add-service=http --permanent
sudo firewall-cmd --add-service=https --permanent
sudo firewall-cmd --reload
```

### Step 2: Generate Let's Encrypt Certificate

```bash
cd infrastructure/certbot
./generate-letsencrypt.sh yourdomain.com your-email@example.com
```

**What this script does:**
1. Stops Nginx temporarily (frees port 80)
2. Runs certbot in standalone mode
3. Requests certificate from Let's Encrypt
4. Validates domain ownership via HTTP challenge
5. Installs certificate
6. Restarts Nginx

**Expected output:**
```
============================================
Let's Encrypt SSL Certificate Generator
============================================

Configuration:
  Domain: yourdomain.com
  Email:  your-email@example.com

Step 1/5: Creating directories...
✅ Directories created

Step 2/5: Checking DNS resolution...
✅ DNS resolves to: 203.0.113.42

Step 3/5: Checking port 80 accessibility...
   Make sure port 80 is open in your firewall

Step 4/5: Stopping Nginx temporarily...
✅ Nginx stopped

Step 5/5: Requesting certificate from Let's Encrypt...
   This may take 1-2 minutes...

✅ Certificate successfully obtained!

============================================
Success! Certificate installed
============================================

📁 Certificate location:
   /path/to/infrastructure/certbot/conf/live/yourdomain.com/

📋 Next steps:
   1. Update nginx.conf to use Let's Encrypt certificate
   2. Restart Nginx
   3. Test HTTPS
   4. Test HTTP/2
```

### Step 3: Update Nginx Configuration

Edit `infrastructure/nginx/nginx.conf`:

```nginx
# ============ SSL CERTIFICATES ============
# Development: Self-signed certificate (comment out)
# ssl_certificate /etc/nginx/ssl/cert.pem;
# ssl_certificate_key /etc/nginx/ssl/key.pem;

# Production: Let's Encrypt (uncomment)
ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
ssl_trusted_certificate /etc/letsencrypt/live/yourdomain.com/chain.pem;
```

**Also enable SSL stapling (optional but recommended):**

```nginx
# SSL stapling (enable for production with valid cert)
ssl_stapling on;
ssl_stapling_verify on;
```

**Update server_name (optional but recommended):**

```nginx
server {
    listen 443 ssl http2;
    server_name yourdomain.com www.yourdomain.com;  # Change from _
    # ... rest of config
}
```

### Step 4: Restart Nginx

```bash
cd ../../
docker-compose restart nginx
```

### Step 5: Test Production Setup

```bash
# Test HTTP/2
./test-http2.sh yourdomain.com 443

# Test in browser (no security warnings!)
# Open: https://yourdomain.com

# Check SSL grade
# Visit: https://www.ssllabs.com/ssltest/analyze.html?d=yourdomain.com
```

---

## Part 3: Auto-Renewal Setup

Let's Encrypt certificates expire after **90 days**. Set up auto-renewal:

### Option 1: Cron Job (Recommended)

```bash
# Edit crontab
crontab -e

# Add this line (runs daily at 3 AM)
0 3 * * * /path/to/infrastructure/certbot/renew-certificates.sh >> /var/log/certbot-renewal.log 2>&1
```

**Full path example:**
```bash
0 3 * * * /home/user/edge-cloud-storage-final-mvp/infrastructure/certbot/renew-certificates.sh >> /var/log/certbot-renewal.log 2>&1
```

### Option 2: Systemd Timer (Alternative)

Create `/etc/systemd/system/certbot-renewal.service`:

```ini
[Unit]
Description=Certbot Renewal
After=network.target

[Service]
Type=oneshot
ExecStart=/path/to/infrastructure/certbot/renew-certificates.sh
User=root
```

Create `/etc/systemd/system/certbot-renewal.timer`:

```ini
[Unit]
Description=Run certbot renewal daily
Requires=certbot-renewal.service

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
```

Enable and start:

```bash
sudo systemctl enable certbot-renewal.timer
sudo systemctl start certbot-renewal.timer
sudo systemctl status certbot-renewal.timer
```

### Test Auto-Renewal

```bash
# Dry run (test without actually renewing)
cd infrastructure/certbot
./renew-certificates.sh --dry-run
```

---

## Part 4: Force HTTPS (Optional but Recommended)

Redirect all HTTP traffic to HTTPS for security:

Edit `infrastructure/nginx/nginx.conf` - update the HTTP server block:

```nginx
# ============ HTTP SERVER ============
server {
    listen 80;
    server_name _;

    # ACME challenge for Let's Encrypt
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }

    # Redirect all HTTP to HTTPS
    location / {
        return 301 https://$host$request_uri;
    }
}
```

**Benefits:**
- ✅ All traffic encrypted
- ✅ No mixed content warnings
- ✅ Better SEO (Google prefers HTTPS)
- ✅ Required for HTTP/2

**Restart Nginx:**

```bash
docker-compose restart nginx
```

---

## Part 5: Performance Verification

### Test 1: HTTP/2 Confirmation

```bash
# Should show "HTTP/2"
curl -I https://yourdomain.com
```

### Test 2: Download Performance

```bash
# Upload a 400MB test file, then download it
time curl -o /dev/null https://yourdomain.com/api/v1/files/FILE_ID/download \
  -H "Authorization: Bearer TOKEN"

# Expected: ~1.6 seconds (87% improvement from baseline 12s)
```

### Test 3: Concurrent Downloads

```bash
# Test 10 concurrent downloads
for i in {1..10}; do
  curl -o "download_$i.bin" \
    https://yourdomain.com/api/v1/files/FILE_ID/download \
    -H "Authorization: Bearer TOKEN" &
done
wait

# Should complete without errors or slowdowns
```

### Test 4: SSL Grade

Visit: https://www.ssllabs.com/ssltest/analyze.html?d=yourdomain.com

**Expected Grade: A or A+**

---

## Part 6: Monitoring and Maintenance

### Monitor Certificate Expiration

```bash
# Check certificate expiration date
openssl s_client -connect yourdomain.com:443 -servername yourdomain.com </dev/null 2>/dev/null | \
  openssl x509 -noout -dates

# Output:
# notBefore=Jan 15 00:00:00 2024 GMT
# notAfter=Apr 15 23:59:59 2024 GMT  <-- Should be ~90 days from now
```

### Check Renewal Logs

```bash
# View renewal log
tail -f /var/log/certbot-renewal.log

# Manual renewal test
cd infrastructure/certbot
./renew-certificates.sh --dry-run
```

### Performance Monitoring

```bash
# Monitor Nginx logs
docker logs -f edge-nginx | grep "HTTP/2"

# Check connection stats
docker exec edge-nginx sh -c "nginx -T" | grep http2
```

---

## Troubleshooting

### Issue 1: "Failed to obtain certificate"

**Possible causes:**
1. DNS not pointing to server
2. Port 80 blocked by firewall
3. Domain not resolving correctly
4. Rate limit reached (5 certs per week per domain)

**Solutions:**

```bash
# Check DNS
dig +short yourdomain.com

# Check port 80
nc -zv yourdomain.com 80

# Check rate limit
# Visit: https://crt.sh/?q=yourdomain.com

# Manual certbot test
docker run --rm -it \
  -p 80:80 \
  certbot/certbot certonly \
  --standalone \
  --preferred-challenges http \
  --email your-email@example.com \
  --agree-tos \
  --dry-run \
  -d yourdomain.com
```

### Issue 2: "Certificate not found" after renewal

**Solution:**

```bash
# Check certificate location
ls -la infrastructure/certbot/conf/live/yourdomain.com/

# Verify nginx.conf paths match
grep ssl_certificate infrastructure/nginx/nginx.conf

# Restart nginx
docker-compose restart nginx
```

### Issue 3: Browser still shows "Not Secure"

**Possible causes:**
1. Using HTTP instead of HTTPS
2. Mixed content (HTTP resources on HTTPS page)
3. Certificate not trusted

**Solutions:**

```bash
# Force HTTPS redirect (see Part 4 above)

# Check for mixed content in browser console (F12)

# Verify certificate chain
openssl s_client -connect yourdomain.com:443 -showcerts
```

### Issue 4: HTTP/2 not working after migration

**Solution:**

```bash
# Check nginx HTTP/2 config
docker exec edge-nginx nginx -T | grep "listen.*443.*http2"

# Should output:
# listen 443 ssl http2;

# Restart nginx
docker-compose restart nginx

# Test HTTP/2
./test-http2.sh yourdomain.com 443
```

---

## Rollback Procedure

If you need to rollback to development setup:

```bash
# 1. Edit nginx.conf
# Comment out Let's Encrypt certificates
# Uncomment self-signed certificates

# 2. Restart Nginx
docker-compose restart nginx

# 3. Test
./test-http2.sh localhost 443
```

---

## Cost Summary

| Item | Cost | Frequency |
|------|------|-----------|
| **Domain Name** | $8-15 | Annual |
| **Let's Encrypt SSL** | FREE | Auto-renews every 90 days |
| **Total** | **$8-15/year** | - |

**Comparison with alternatives:**
- Paid SSL certificate: $50-200/year
- Cloud load balancer SSL: $180-360/year

**Let's Encrypt is the most cost-effective option!**

---

## Performance Summary

### Before Migration (Development):
- ✅ HTTP/2 enabled
- ⚠️ Self-signed certificate (browser warnings)
- ✅ 87% improvement (12s → 1.6s downloads)

### After Migration (Production):
- ✅ HTTP/2 enabled
- ✅ Trusted certificate (no warnings)
- ✅ 87% improvement (12s → 1.6s downloads)
- ✅ SEO benefits
- ✅ Professional appearance

**Performance stays the same, but with production-ready security!**

---

## Checklist

### Pre-Migration
- [ ] Domain purchased
- [ ] DNS configured (A records)
- [ ] DNS propagated (tested with dig/nslookup)
- [ ] Ports 80 and 443 open
- [ ] Backup current nginx.conf

### Migration
- [ ] Run generate-letsencrypt.sh
- [ ] Certificate obtained successfully
- [ ] nginx.conf updated
- [ ] Nginx restarted
- [ ] HTTPS accessible (https://yourdomain.com)
- [ ] HTTP/2 verified (./test-http2.sh)
- [ ] No browser warnings

### Post-Migration
- [ ] Auto-renewal configured (cron job)
- [ ] HTTP → HTTPS redirect enabled
- [ ] SSL grade checked (SSL Labs)
- [ ] Performance tested (downloads)
- [ ] Monitoring set up
- [ ] Documentation updated with domain name

---

## Support Resources

### Let's Encrypt
- Documentation: https://letsencrypt.org/docs/
- Rate limits: https://letsencrypt.org/docs/rate-limits/
- FAQ: https://letsencrypt.org/docs/faq/

### Testing Tools
- SSL Test: https://www.ssllabs.com/ssltest/
- HTTP/2 Test: https://tools.keycdn.com/http2-test
- DNS Check: https://www.whatsmydns.net

### Community Support
- Let's Encrypt Community: https://community.letsencrypt.org/
- Nginx Forum: https://forum.nginx.org/

---

**Questions or issues?** Check the troubleshooting section above or open an issue in the project repository.

---

**Last Updated:** 2025-10-29
**Version:** 1.0
**Status:** Ready for Production Migration
