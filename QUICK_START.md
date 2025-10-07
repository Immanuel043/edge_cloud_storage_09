# Quick Start Guide - Production Nginx Setup

## ✅ What's New - Production-Grade Nginx

Your nginx has been upgraded with enterprise security and performance features!

### New Features Added:

1. **🛡️ Rate Limiting** - Protects against DDoS and abuse
   - Auth endpoints: 5 req/s (brute force protection)
   - Uploads: 10 req/s
   - Downloads: 50 req/s
   - General API: 100 req/s

2. **🔒 Security Headers** - Industry-standard protection
   - X-Frame-Options, CSP, HSTS (when HTTPS enabled)
   - XSS Protection, MIME sniffing prevention
   - Referrer Policy, Permissions Policy

3. **📊 Advanced Logging** - Detailed performance metrics
   - Request timing, upstream performance
   - JSON format support for log aggregators

4. **🚀 Performance** - Optimized for production
   - Gzip compression (6x smaller responses)
   - Static asset caching (1 year)
   - Connection keep-alive (1000 req/conn)

5. **🔐 SSL/TLS Ready** - Modern encryption
   - TLS 1.2 & 1.3 support
   - Let's Encrypt integration
   - Self-signed certs for dev

## 🏃 Start Services

### Option 1: Start Everything
```bash
cd infrastructure
docker-compose up -d
```

### Option 2: Start Specific Services
```bash
# Start core services first
docker-compose up -d postgres redis elasticsearch

# Wait 30 seconds, then start app services
docker-compose up -d storage-service chunk-processor web-service nginx
```

## 🧪 Test the Setup

### 1. Check nginx is running:
```bash
docker ps | grep nginx
```

### 2. Test health endpoint:
```bash
curl http://localhost/health
# Expected: "healthy"
```

### 3. Check access logs:
```bash
docker exec edge-nginx tail -f /var/log/nginx/access.log
```

### 4. Test rate limiting (optional):
```bash
# This should trigger 429 errors after burst:
for i in {1..20}; do curl -I http://localhost/api/v1/auth/login 2>&1 | grep "HTTP"; done
```

## 📱 Access Your App

- **Web UI**: http://localhost
- **API**: http://localhost/api/v1/
- **Health Check**: http://localhost/health

## 🔐 Enable HTTPS (Optional)

### For Development (Self-Signed):
```bash
cd infrastructure
./scripts/setup-ssl.sh
# Select option 1
# Follow prompts
```

### For Production (Let's Encrypt):
```bash
cd infrastructure
./scripts/setup-ssl.sh
# Select option 2
# Enter your domain and email
# Update nginx.conf with your domain (line 281)
# Uncomment HTTPS server block (lines 279-305)
docker-compose restart nginx
```

## 📊 Monitor Performance

### View Rate Limiting Activity:
```bash
docker exec edge-nginx grep " 429 " /var/log/nginx/access.log
```

### Check Request Timing:
```bash
docker exec edge-nginx tail -f /var/log/nginx/access.log | grep "rt="
```

### Test nginx Config:
```bash
docker exec edge-nginx nginx -t
```

## 🛠️ Troubleshooting

### Service won't start:
```bash
docker-compose logs [service-name]
```

### Nginx configuration error:
```bash
docker exec edge-nginx nginx -t
```

### Rate limited (429 error):
Increase limits in `nginx.conf` lines 43-46 or whitelist your IP

### Upload fails (413 error):
Check `client_max_body_size` in nginx.conf - already set to unlimited for uploads

## 📚 Documentation

- **Full nginx setup**: `/docs/NGINX_PRODUCTION_SETUP.md`
- **Production checklist**: `/docs/PRODUCTION_READY_CHECKLIST.md`
- **Security features**: `/docs/SECURITY_FEATURES.md`
- **SSL setup script**: `./infrastructure/scripts/setup-ssl.sh`

## 🎯 Next Steps

1. ✅ Start services: `docker-compose up -d`
2. ✅ Test health: `curl http://localhost/health`
3. ✅ Access UI: http://localhost
4. 🔐 (Optional) Set up SSL for production
5. 📊 Monitor logs for rate limiting activity
6. 🚀 Deploy!

## 🔥 Production Deployment Checklist

When deploying to production:

- [ ] Generate Let's Encrypt SSL certificate
- [ ] Update nginx.conf `server_name` with your domain
- [ ] Uncomment HTTPS server block in nginx.conf
- [ ] Enable HTTP → HTTPS redirect
- [ ] Test SSL: https://www.ssllabs.com/ssltest/
- [ ] Test headers: https://securityheaders.com/
- [ ] Set up log rotation
- [ ] Configure monitoring/alerts
- [ ] Test rate limiting behavior

## 💡 Tips

- **Rate limits are active** - Monitor 429 errors in logs
- **Logs are detailed** - Shows request timing and performance
- **SSL is ready** - Just run setup-ssl.sh when needed
- **Security headers work** - Test at securityheaders.com
- **Caching is enabled** - Static files cached for 1 year

Your nginx is now **production-ready**! 🚀
