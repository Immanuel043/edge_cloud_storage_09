# Production Deployment Checklist

## Status: Phase 1 Complete - Ready for Testing & Deployment

This checklist covers all tasks that must be completed before deploying the billing system to production.

---

## ✅ Completed (Phase 0 & Phase 1)

### Security Hardening
- [x] Fixed hardcoded absolute paths
- [x] Installed shared-billing as proper package
- [x] Fixed destructive database migration (data loss prevented)
- [x] Fixed hardcoded frontend URLs
- [x] Implemented missing billing portal endpoint
- [x] Added webhook secret validation (enforced)
- [x] Added DEV_MODE safeguards
- [x] Enhanced .gitignore for secret protection
- [x] Created pre-commit hooks for secret detection
- [x] Implemented rate limiting on billing endpoints
- [x] Implemented webhook idempotency tracking

---

## 🔴 CRITICAL - Must Complete Before Production

### 1. Secret Rotation & Management

#### Rotate Mailgun API Key ⚠️ CRITICAL
- [ ] Log into Mailgun dashboard: https://app.mailgun.com/
- [ ] Generate new API key (Settings → API Security)
- [ ] Update `infrastructure/.env` with new key
- [ ] Test email functionality
- [ ] Revoke old key: `[REDACTED - Check Mailgun dashboard for exposed keys]`
- [ ] Document new key in secrets manager (DO NOT commit)

**See**: [SECURITY_ROTATION_REQUIRED.md](SECURITY_ROTATION_REQUIRED.md) for detailed instructions

#### Move Secrets to AWS Secrets Manager
- [ ] Create AWS Secrets Manager secrets:
  ```
  edgevault/production/mailgun-api-key
  edgevault/production/razorpay-key-id
  edgevault/production/razorpay-key-secret
  edgevault/production/razorpay-webhook-secret
  edgevault/production/stripe-secret-key
  edgevault/production/stripe-publishable-key
  edgevault/production/stripe-webhook-secret
  ```
- [ ] Update deployment scripts to fetch from Secrets Manager
- [ ] Remove `.env` files from production servers
- [ ] Verify secrets are never logged

### 2. Database Migration

#### Run Migrations
- [ ] Backup production database first
- [ ] Run migration in staging environment:
  ```bash
  cd services/storage-service
  alembic upgrade head
  ```
- [ ] Verify tables created:
  - `subscription_plans`
  - `user_subscriptions`
  - `subscription_history`
  - `webhook_events`
- [ ] Check data integrity
- [ ] Run migration in production

#### Verify Migration Safety
- [ ] Confirm no DELETE statements in migrations
- [ ] Verify soft delete (is_active flag) used
- [ ] Test rollback capability
- [ ] Verify existing user subscriptions migrated correctly

### 3. Webhook Integration

#### Integrate Idempotency (Required)
- [ ] Update Stripe webhook handler with idempotency checks
- [ ] Update Razorpay webhook handler with idempotency checks
- [ ] Add rate limiting to webhook endpoints
- [ ] Test duplicate event handling
- [ ] Test timestamp validation
- [ ] Test IP whitelisting (production mode)

**See**: [WEBHOOK_IDEMPOTENCY_INTEGRATION_GUIDE.md](WEBHOOK_IDEMPOTENCY_INTEGRATION_GUIDE.md)

#### Configure Webhook URLs
- [ ] Update Stripe webhook URL: `https://yourdomain.com/api/v1/billing/webhook/stripe`
- [ ] Update Razorpay webhook URL: `https://yourdomain.com/api/v1/billing/webhooks/razorpay`
- [ ] Verify webhook secrets configured
- [ ] Test webhook delivery from Stripe dashboard
- [ ] Test webhook delivery from Razorpay dashboard

### 4. Environment Configuration

#### Backend Environment Variables
- [ ] Create `.env.production` file (DO NOT commit)
- [ ] Set all required variables:
  ```bash
  # Environment
  ENVIRONMENT=production
  DEV_MODE=false  # CRITICAL - must be false

  # Database
  DATABASE_URL=postgresql+asyncpg://...
  REDIS_URL=redis://...

  # Razorpay
  RAZORPAY_KEY_ID=rzp_live_...
  RAZORPAY_KEY_SECRET=...
  RAZORPAY_WEBHOOK_SECRET=...

  # Stripe
  STRIPE_SECRET_KEY=sk_live_...
  STRIPE_PUBLISHABLE_KEY=pk_live_...
  STRIPE_WEBHOOK_SECRET=whsec_...

  # Mailgun
  MAILGUN_API_KEY=...  # NEW rotated key
  MAILGUN_DOMAIN=...
  MAILGUN_FROM_EMAIL=...

  # URLs
  PAYMENT_SUCCESS_URL=https://yourdomain.com/billing/success
  PAYMENT_FAILURE_URL=https://yourdomain.com/billing/failed
  ```
- [ ] Verify all secrets are from production (live_ not test_)
- [ ] Double-check DEV_MODE=false

#### Frontend Environment Variables
- [ ] Create `frontend-clean/.env.production`
- [ ] Set API URLs:
  ```bash
  VITE_STORAGE_API_URL=https://api.yourdomain.com
  VITE_ZK_API_URL=https://zk.yourdomain.com
  ```
- [ ] Build frontend: `npm run build`
- [ ] Verify API URLs in built assets

### 5. Security Setup

#### Install Pre-commit Hooks
- [ ] Install pre-commit: `pip install pre-commit`
- [ ] Install hooks: `pre-commit install`
- [ ] Test hooks: `pre-commit run --all-files`
- [ ] Verify secret detection works
- [ ] Add to CI/CD pipeline

#### Configure Firewall Rules
- [ ] Whitelist Stripe webhook IPs (see `webhook_idempotency.py`)
- [ ] Whitelist Razorpay webhook IPs
- [ ] Restrict database access to application servers only
- [ ] Configure Redis firewall rules

---

## 🟡 IMPORTANT - Recommended Before Production

### 6. Testing

#### Unit Tests
- [ ] Test rate limiting (exceed limits, verify 429 responses)
- [ ] Test webhook idempotency (duplicate events)
- [ ] Test DEV_MODE validation (should fail in production)
- [ ] Test payment creation flow
- [ ] Test payment verification
- [ ] Test subscription upgrades/downgrades

#### Integration Tests
- [ ] Test full payment flow with Stripe (test mode first)
- [ ] Test full payment flow with Razorpay (test mode first)
- [ ] Test webhook delivery and processing
- [ ] Test rate limit recovery after window expires
- [ ] Test billing portal access

#### Load Tests
- [ ] Simulate high webhook volume (100+ concurrent)
- [ ] Test rate limiter under load
- [ ] Monitor Redis performance
- [ ] Monitor PostgreSQL webhook_events table performance

### 7. Monitoring & Alerting

#### Set Up Monitoring
- [ ] Monitor rate limit violations (log aggregation)
- [ ] Monitor webhook processing failures
- [ ] Monitor duplicate webhook rate
- [ ] Monitor Redis availability
- [ ] Monitor database connection pool

#### Configure Alerts
- [ ] Alert on high rate limit violation rate (>100/hour)
- [ ] Alert on webhook processing failure rate (>5%)
- [ ] Alert on Redis connection failures
- [ ] Alert on DEV_MODE enabled (should never happen in prod)
- [ ] Alert on database migration failures

#### Logging
- [ ] Ensure structured logging enabled
- [ ] Log all payment events (success, failure)
- [ ] Log all webhook events (already handled by idempotency)
- [ ] Log rate limit violations
- [ ] Centralize logs (CloudWatch, ELK, etc.)

### 8. Documentation

#### Update Documentation
- [ ] Document new API endpoints
- [ ] Document rate limit policies
- [ ] Document webhook retry behavior
- [ ] Create runbook for common issues
- [ ] Document emergency rollback procedure

#### Team Training
- [ ] Share security implementation docs with team
- [ ] Review webhook idempotency integration guide
- [ ] Review secret rotation procedures
- [ ] Document on-call escalation procedures

---

## 🟢 OPTIONAL - Enhance Production Quality

### 9. Additional Features (Phase 2)

#### Audit Logging
- [ ] Log all subscription changes
- [ ] Log all payment attempts
- [ ] Log all admin actions
- [ ] Store logs for compliance (7 years for financial data)

#### Admin Dashboard
- [ ] View all subscriptions
- [ ] Search users by email/subscription
- [ ] View payment history
- [ ] Manual subscription adjustment capability
- [ ] Webhook event viewer

#### Email Notifications
- [ ] Payment successful
- [ ] Payment failed
- [ ] Subscription upgraded
- [ ] Subscription cancelled
- [ ] Trial ending soon (if implementing trials)

#### Refund Flow
- [ ] Implement refund endpoint
- [ ] 7-day full refund policy logic
- [ ] Partial refund support
- [ ] Refund notification emails

### 10. Performance Optimization

- [ ] Add database indexes for common queries
- [ ] Implement caching for plan catalog
- [ ] Optimize webhook_events table (partitioning if high volume)
- [ ] Add CDN for frontend assets
- [ ] Enable gzip compression

### 11. Compliance

- [ ] Review GDPR compliance (data retention, deletion)
- [ ] Review PCI DSS compliance (payment handling)
- [ ] Add privacy policy references
- [ ] Add terms of service acceptance
- [ ] Document data retention policies

---

## Pre-Deployment Verification

### Final Checks

Run through this checklist 24 hours before deployment:

#### Configuration
- [ ] All environment variables set correctly
- [ ] All secrets rotated and stored in Secrets Manager
- [ ] No `.env` files in production codebase
- [ ] DEV_MODE=false verified
- [ ] ENVIRONMENT=production verified

#### Database
- [ ] Production database backup taken
- [ ] Migrations tested in staging
- [ ] Rollback plan documented
- [ ] Database connection pool sized correctly

#### Code
- [ ] All tests passing
- [ ] No debug statements in code
- [ ] No TODO/FIXME comments in critical paths
- [ ] Pre-commit hooks installed
- [ ] Code reviewed by team

#### Security
- [ ] Webhook secrets configured
- [ ] Rate limiting tested
- [ ] Idempotency tested
- [ ] Firewall rules applied
- [ ] SSL/TLS certificates valid

#### Monitoring
- [ ] Alerts configured
- [ ] Dashboards created
- [ ] Log aggregation working
- [ ] On-call rotation set

---

## Post-Deployment Verification

### Immediately After Deployment (First 30 Minutes)

- [ ] Verify application starts without errors
- [ ] Check DEV_MODE warning (should NOT appear in logs)
- [ ] Test plan catalog endpoint: `GET /api/v1/billing/plans`
- [ ] Test user subscription endpoint: `GET /api/v1/billing/subscription`
- [ ] Verify rate limiting works (test endpoint multiple times)
- [ ] Monitor error logs for any issues

### First 24 Hours

- [ ] Monitor webhook delivery success rate
- [ ] Check for duplicate webhook events in database
- [ ] Verify no rate limit false positives
- [ ] Monitor Redis performance
- [ ] Check database query performance
- [ ] Review all error logs

### First Week

- [ ] Process test payment with real credit card (small amount)
- [ ] Verify webhook processing
- [ ] Check subscription activation
- [ ] Monitor payment success rate
- [ ] Review webhook_events table growth
- [ ] Clean up any test data

---

## Emergency Rollback Procedure

If critical issues arise:

### Immediate Actions

1. **Disable new signups** (prevent new subscriptions)
2. **Enable maintenance mode** if necessary
3. **Check error logs** for root cause
4. **Contact on-call engineer**

### Rollback Database Migration

```bash
cd services/storage-service
alembic downgrade -1  # Go back one migration
```

### Rollback Application Code

```bash
git revert HEAD
# Or redeploy previous version
```

### Disable Webhooks Temporarily

- Pause webhook delivery in Stripe dashboard
- Pause webhook delivery in Razorpay dashboard
- Fix issues
- Re-enable and process backlog

---

## Support Contacts

### Payment Providers

- **Stripe Support**: https://support.stripe.com/
- **Razorpay Support**: https://razorpay.com/support/

### Infrastructure

- **AWS Support**: (Your support tier)
- **Database Admin**: (Contact info)
- **DevOps Team**: (Contact info)

---

## Success Criteria

Production deployment is considered successful when:

- ✅ All critical checklist items completed
- ✅ No errors in logs for 24 hours
- ✅ Webhook processing success rate >99%
- ✅ Rate limiting working correctly (no false positives)
- ✅ At least one successful payment processed
- ✅ Monitoring and alerts functioning
- ✅ Team trained on new system

---

**Last Updated**: 2026-01-09
**Next Review**: Before production deployment
**Owner**: DevOps + Backend Team
