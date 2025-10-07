# Nginx Production Setup Guide

## Overview

This guide covers the production-grade nginx configuration for Edge Cloud Storage, including SSL/TLS, rate limiting, security headers, and DDoS protection.

## Features Implemented

### 1. SSL/TLS Configuration ✓
- **TLS 1.2 & 1.3** support only (no outdated protocols)
- **Modern cipher suites** (ECDHE, ChaCha20-Poly1305)
- **OCSP stapling** for certificate validation
- **SSL session caching** for performance
- Support for both **self-signed** (dev) and **Let's Encrypt** (prod) certificates

### 2. Rate Limiting ✓
Protection against API abuse with different limits per endpoint:

| Endpoint Type | Rate Limit | Burst | Purpose |
|--------------|------------|-------|---------|
| Authentication | 5 req/s | 10 | Prevent brute force attacks |
| Upload | 10 req/s | 5 | Control upload traffic |
| Download | 50 req/s | 20 | Prevent download abuse |
| General API | 100 req/s | 50 | Overall API protection |

### 3. Security Headers ✓

#### HSTS (HTTP Strict Transport Security)
```nginx
Strict-Transport-Security: max-age=31536000; includeSubDomains; preload
```
- Forces HTTPS for 1 year
- Applies to all subdomains
- Preload ready

#### CSP (Content Security Policy)
```nginx
Content-Security-Policy:
  default-src 'self';
  script-src 'self' 'unsafe-inline' 'unsafe-eval';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: https:;
  connect-src 'self' ws: wss:;
  frame-ancestors 'none';
```

#### Other Headers
- `X-Frame-Options: DENY` - Prevents clickjacking
- `X-Content-Type-Options: nosniff` - Prevents MIME sniffing
- `X-XSS-Protection: 1; mode=block` - XSS protection
- `Referrer-Policy: strict-origin-when-cross-origin` - Privacy
- `Permissions-Policy` - Disable unnecessary browser features

### 4. DDoS Protection ✓

#### Connection Limits
- **50 concurrent connections per IP**
- **10,240 worker connections** total
- **Slow loris protection** (10s timeouts)

#### Request Timeouts
- Body: 10s (overridden to 2h for uploads)
- Header: 10s
- Send: 10s

### 5. Logging ✓

#### Standard Format (main)
Includes request timing and upstream metrics:
- Request time
- Upstream connect/header/response time
- Client IP, user agent, referer

#### JSON Format (json_combined)
Structured logging for log aggregation tools (ELK, Splunk, etc.)

### 6. Performance Optimizations ✓

#### Compression
- **Gzip compression** (level 6)
- Compressed types: text, JSON, JavaScript, XML, SVG
- Minimum size: 1KB

#### Caching
- Static assets: 1 year cache
- HTML: No cache (always fresh)
- WebSocket: No buffering

#### Keep-Alive
- Connection reuse enabled
- 1000 requests per connection
- 65s timeout

## Setup Instructions

### Option 1: Self-Signed Certificates (Development)

1. **Generate certificates:**
```bash
cd infrastructure
./scripts/setup-ssl.sh
# Select option 1 (Self-signed)
```

2. **Update nginx.conf** (lines 174-176):
```nginx
ssl_certificate /etc/nginx/ssl/fullchain.pem;
ssl_certificate_key /etc/nginx/ssl/privkey.pem;
ssl_trusted_certificate /etc/nginx/ssl/chain.pem;
```

3. **Enable SSL volumes in docker-compose.yml** (line 338):
```yaml
- ./ssl:/etc/nginx/ssl:ro
```

4. **Create log directory:**
```bash
mkdir -p logs/nginx
```

5. **Restart nginx:**
```bash
docker-compose restart nginx
```

6. **Access your app:**
- HTTP: http://localhost
- HTTPS: https://localhost (accept security warning)

### Option 2: Let's Encrypt Certificates (Production)

1. **Prerequisites:**
   - Domain name pointing to your server's IP
   - Port 80 accessible from internet
   - Valid email address

2. **Generate certificates:**
```bash
cd infrastructure
./scripts/setup-ssl.sh
# Select option 2 (Let's Encrypt)
# Enter domain and email when prompted
```

3. **Update nginx.conf** (lines 171, 174-176):
```nginx
server_name yourdomain.com;  # Replace with your domain

ssl_certificate /etc/letsencrypt/live/yourdomain.com/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/yourdomain.com/privkey.pem;
ssl_trusted_certificate /etc/letsencrypt/live/yourdomain.com/chain.pem;
```

4. **Enable HTTPS redirect** (uncomment line 160):
```nginx
return 301 https://$host$request_uri;
```

5. **Enable certbot volumes in docker-compose.yml** (lines 340-341):
```yaml
- ./certbot/conf:/etc/letsencrypt:ro
- ./certbot/www:/var/www/certbot:ro
```

6. **Start with auto-renewal:**
```bash
docker-compose --profile production up -d
```

7. **Test auto-renewal:**
```bash
docker exec edge-certbot certbot renew --dry-run
```

## Configuration Reference

### Rate Limit Zones

Located in nginx.conf lines 50-54:

```nginx
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=100r/s;
limit_req_zone $binary_remote_addr zone=auth_limit:10m rate=5r/s;
limit_req_zone $binary_remote_addr zone=upload_limit:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=download_limit:10m rate=50r/s;
```

**Adjust rates based on your needs:**
- `rate=X/s` - Requests per second
- `burst=Y` - Allow burst traffic
- `nodelay` - Don't delay burst requests

### Whitelisting IPs

To bypass rate limits for trusted IPs (lines 119-124):

```nginx
geo $limit {
    default 1;
    10.0.0.0/8 0;       # Whitelist private network
    172.16.0.0/12 0;    # Docker network
    1.2.3.4 0;          # Specific trusted IP
}
```

### Custom Logging

To enable JSON logging (line 40):

```nginx
access_log /var/log/nginx/access.log json_combined;
```

### Upload Size Limits

Default: 10MB (line 47)
Upload endpoints: Unlimited (line 252)

To change default:
```nginx
client_max_body_size 100m;  # Allow 100MB
```

## Monitoring & Troubleshooting

### View Access Logs
```bash
docker exec edge-nginx tail -f /var/log/nginx/access.log
```

### View Error Logs
```bash
docker exec edge-nginx tail -f /var/log/nginx/error.log
```

### Test Configuration
```bash
docker exec edge-nginx nginx -t
```

### Reload Configuration (no downtime)
```bash
docker exec edge-nginx nginx -s reload
```

### Check Rate Limit Status
Look for HTTP 429 responses in access logs:
```bash
docker exec edge-nginx grep " 429 " /var/log/nginx/access.log
```

### Monitor SSL Certificate Expiry
```bash
docker exec edge-certbot certbot certificates
```

## Security Best Practices

### 1. Update Domain Name
Replace `_` with your actual domain in:
- Line 142 (HTTP server)
- Line 171 (HTTPS server)

### 2. Customize CSP
Adjust Content-Security-Policy (line 183) based on your app's needs:
```nginx
# If you use external CDNs:
script-src 'self' https://cdn.example.com;

# If you don't need inline scripts (best security):
script-src 'self';  # Remove 'unsafe-inline' 'unsafe-eval'
```

### 3. Enable HSTS Preload
After 30 days of HSTS, submit to: https://hstspreload.org/

### 4. Monitor Security Headers
Test with: https://securityheaders.com/

### 5. SSL Labs Test
Check SSL config: https://www.ssllabs.com/ssltest/

## Performance Tuning

### Worker Processes
Auto-detected based on CPU cores (line 2):
```nginx
worker_processes auto;  # Uses all available cores
```

### Worker Connections
Current: 10,240 (line 10)
Increase for high traffic:
```nginx
worker_connections 20480;
```

### Buffer Sizes
Adjust for large files (lines 294-295):
```nginx
proxy_buffer_size 256k;
proxy_buffers 8 256k;
```

### Enable Brotli (if available)
Uncomment lines 92-95 for better compression than gzip.

## Rate Limit Examples

### Strict Auth Protection
```nginx
location /api/v1/login {
    limit_req zone=auth_limit burst=3 nodelay;  # Only 3 burst
    # ... proxy config
}
```

### Per-User Rate Limiting
```nginx
limit_req_zone $cookie_session_id zone=user_limit:10m rate=50r/s;
```

### Exclude Specific Paths
```nginx
location /api/v1/public {
    # No rate limit
    proxy_pass http://fastapi_upstream;
}
```

## Troubleshooting Common Issues

### Issue: 502 Bad Gateway
**Cause:** Backend service down
**Solution:**
```bash
docker-compose ps storage-service
docker-compose logs storage-service
```

### Issue: 413 Request Entity Too Large
**Cause:** Body size limit exceeded
**Solution:** Increase `client_max_body_size` for the location

### Issue: 429 Too Many Requests
**Cause:** Rate limit exceeded
**Solution:**
- Increase rate limit or burst size
- Add IP to whitelist

### Issue: SSL Certificate Error
**Cause:** Certificate path incorrect or expired
**Solution:**
```bash
# Check certificate
docker exec edge-certbot certbot certificates

# Renew manually
docker exec edge-certbot certbot renew --force-renewal
```

### Issue: WebSocket Connection Failed
**Cause:** Upgrade headers not set
**Solution:** Ensure lines 63-68 are present in WebSocket location

## Production Checklist

Before going live:

- [ ] Update `server_name` with your domain
- [ ] Generate Let's Encrypt certificates
- [ ] Enable HTTPS redirect (line 160)
- [ ] Update CSP policy for your app
- [ ] Set up log rotation (see below)
- [ ] Test SSL configuration (ssllabs.com)
- [ ] Test security headers (securityheaders.com)
- [ ] Monitor rate limit logs
- [ ] Set up certbot auto-renewal
- [ ] Configure firewall (allow 80, 443)
- [ ] Set up monitoring/alerts

## Log Rotation

Create `/etc/logrotate.d/nginx`:
```bash
/var/log/nginx/*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 nginx adm
    sharedscripts
    postrotate
        docker exec edge-nginx nginx -s reload
    endscript
}
```

## Additional Resources

- [Nginx Documentation](https://nginx.org/en/docs/)
- [Mozilla SSL Config Generator](https://ssl-config.mozilla.org/)
- [Let's Encrypt Documentation](https://letsencrypt.org/docs/)
- [OWASP Security Headers](https://owasp.org/www-project-secure-headers/)

## Support

For issues or questions:
1. Check nginx error logs
2. Test configuration: `nginx -t`
3. Review this documentation
4. Check GitHub issues
