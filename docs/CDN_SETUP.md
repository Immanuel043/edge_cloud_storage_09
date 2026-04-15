# CDN Setup Playbook (Cloudflare)

This is the operator runbook for putting Cloudflare in front of nginx to offload
preview/thumbnail traffic and static SPA assets. The origin (nginx) is already
configured to emit the correct `Cache-Control` headers — see
`infrastructure/nginx/nginx.conf` (CDN section added in the 2026-04 architecture
review, item #10).

## What's cacheable vs what isn't

| Path pattern                               | Origin `Cache-Control`                     | CDN behavior          |
| ------------------------------------------ | ------------------------------------------ | --------------------- |
| `/api/v1/(files\|share)/*/preview`         | `public, max-age=2592000, s-maxage=604800` | Cache 7 days at edge  |
| `/api/v1/(files\|share)/*/thumbnail`       | `public, max-age=2592000, s-maxage=604800` | Cache 7 days at edge  |
| `/api/v1/*` (everything else)              | `private, no-store`                        | Always bypass         |
| `/api/v1/files/<id>/download`              | `no-cache, no-store, must-revalidate`      | Always bypass         |
| `/*.{js,css,png,woff2,...}` (SPA)          | `public, immutable`, `expires 1y`          | Cache 1 year at edge  |
| `/*.html`                                  | `no-store, no-cache, must-revalidate`      | Always bypass         |

## Cloudflare setup (one-time)

1. **DNS**: Add an A record for your domain pointing to the origin VM's public
   IP. Ensure the orange cloud is ON (proxied).
2. **SSL/TLS → Overview**: Set the encryption mode to **Full (strict)**. Nginx
   must have a valid cert (Let's Encrypt).
3. **SSL/TLS → Edge Certificates**: Enable **Always Use HTTPS** and
   **Automatic HTTPS Rewrites**.
4. **Network**: Enable **HTTP/2** and **HTTP/3 (with QUIC)**. Enable
   **0-RTT Connection Resumption** if available.
5. **Speed → Optimization**: Enable **Brotli**, **Early Hints**, and
   **Rocket Loader: OFF** (it breaks some React bundles).

## Cache Rules (new rules engine)

Cloudflare's modern Cache Rules override Page Rules. Configure these in
**Caching → Cache Rules** in this order:

### Rule 1 — Cache previews/thumbnails at edge
- **When**: `(http.request.uri.path matches "^/api/v1/(files|share)/[^/]+/(preview|thumbnail)")`
- **Then**:
  - Cache eligibility: **Eligible for cache**
  - Edge TTL: **Respect origin** (the origin sends `s-maxage=604800` = 7 days)
  - Browser TTL: **Respect origin** (the origin sends `max-age=2592000` = 30 days)
  - Cache key: Include query string (`?size=small/medium/large` matters)

### Rule 2 — Always bypass authenticated API
- **When**: `(http.request.uri.path contains "/api/v1/") and not (http.request.uri.path matches "^/api/v1/(files|share)/[^/]+/(preview|thumbnail)")`
- **Then**:
  - Cache eligibility: **Bypass cache**

### Rule 3 — Aggressively cache static assets
- **When**: `(http.request.uri.path.extension in {"js" "css" "png" "jpg" "jpeg" "gif" "ico" "svg" "woff" "woff2" "ttf" "eot"})`
- **Then**:
  - Cache eligibility: **Eligible for cache**
  - Edge TTL: 1 year
  - Browser TTL: 1 year

### Rule 4 — Never cache HTML (force SPA refresh)
- **When**: `(http.request.uri.path.extension eq "html") or (http.request.uri.path eq "/")`
- **Then**:
  - Cache eligibility: **Bypass cache**

## Rate limiting under a CDN

The origin nginx config trusts `CF-Connecting-IP` from Cloudflare IP ranges
(see `set_real_ip_from` block in `nginx.conf`). This ensures per-IP rate limits
operate on the real client IP, not the CF edge IP.

**Refresh the Cloudflare IP list quarterly** — the official source is
`https://www.cloudflare.com/ips-v4`. If a CIDR changes, update the
`set_real_ip_from` block in `nginx.conf` and reload nginx.

## Purge-on-deploy

When deploying a new frontend build, purge the CDN's static asset cache so
users fetch the new `index.html` referencing new hashed bundle names:

```bash
# In your deploy script, after uploading the new frontend bundle:
curl -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"files":["https://yourdomain.com/","https://yourdomain.com/index.html"]}'
```

Static assets (`*.js`, `*.css`) don't need to be purged because they have
content-addressable hashes in their filenames — old versions remain cached
harmlessly until they expire naturally.

## Verification

After enabling Cloudflare:

```bash
# Preview request — expect HIT on the second fetch
curl -I https://yourdomain.com/api/v1/files/<id>/preview?size=small \
     -H "Cookie: session=..."
# Look for: CF-Cache-Status: MISS (first), HIT (second)
#           Cache-Control: public, max-age=2592000, s-maxage=604800

# Authenticated API — expect BYPASS on every fetch
curl -I https://yourdomain.com/api/v1/subscription-ui/usage/summary \
     -H "Cookie: session=..."
# Look for: CF-Cache-Status: BYPASS (or DYNAMIC)
#           Cache-Control: private, no-store

# Static asset — expect HIT, long TTL
curl -I https://yourdomain.com/assets/index-abc123.js
# Look for: CF-Cache-Status: HIT
#           Cache-Control: public, immutable
#           Age: (some number)
```

Inside Cloudflare dashboard, **Analytics → Traffic** should show > 70% of
bytes served from the CDN once preview traffic warms up.

## Rolling back

If CDN caching causes an incident, disable it instantly without a deploy:

1. Cloudflare → DNS → toggle the orange cloud OFF for your apex record.
   Traffic now goes direct to origin. Nginx behavior is unchanged (it already
   set correct headers).
2. Or purge the full zone: **Caching → Configuration → Purge Everything**.

No code or config rollback required on the origin.
