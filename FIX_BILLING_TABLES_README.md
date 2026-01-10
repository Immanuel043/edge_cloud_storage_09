# Fix Billing Tables for ZK Service

## Problem
The ZK service dashboard is failing with error:
```
relation "user_subscriptions" does not exist
```

The `BillingService` expects the unified billing schema with:
- `user_subscriptions` table with columns: `service_type`, `plan_id`, `current_period_start`, `current_period_end`, `trial_ends_at`, `extra_metadata`, etc.
- `subscription_plans` table with ZK plans

## Solution

Two SQL scripts are provided:

### Option 1: Safe Migration (Recommended)
**File:** `migrate_user_subscriptions_safe.sql`

This script:
- Checks if tables exist and what schema they have
- Migrates from old schema to new schema if needed
- Preserves data if possible
- Creates missing tables and indexes
- Inserts ZK plans if they don't exist

### Option 2: Clean Recreate
**File:** `fix_user_subscriptions_table.sql`

This script:
- Drops and recreates all tables from scratch
- **WARNING:** This will delete all existing subscription data!

## How to Run

### Step 1: Determine which database to use

The ZK service uses its own database. Check your environment:

```bash
# Check ZK database URL from docker-compose or .env
grep ZK_DATABASE_URL infrastructure/.env
# or
grep ZK_DATABASE_URL infrastructure/docker-compose.yml
```

Default ZK database connection:
- Host: `zk-postgres` (or `localhost` if running locally)
- Port: `5432`
- Database: `zk_db`
- User: `zk_admin`
- Password: `zk_secure_password`

### Step 2: Connect to the database

**Option A: Using psql (if running locally or have direct access)**
```bash
psql -h localhost -p 5432 -U zk_admin -d zk_db
```

**Option B: Using Docker (if using Docker Compose)**
```bash
# Connect to ZK postgres container
docker exec -it zk-postgres psql -U zk_admin -d zk_db
```

**Option C: Using psql from storage-service container (if databases are on same host)**
```bash
docker exec -it edge-storage-service psql -h zk-postgres -U zk_admin -d zk_db
```

### Step 3: Run the migration script

**Recommended (Safe Migration):**
```bash
# From project root
psql -h localhost -p 5432 -U zk_admin -d zk_db -f migrate_user_subscriptions_safe.sql
```

**Or if using Docker:**
```bash
docker exec -i zk-postgres psql -U zk_admin -d zk_db < migrate_user_subscriptions_safe.sql
```

**Or copy and paste the SQL directly:**
```bash
# Copy script content
cat migrate_user_subscriptions_safe.sql | docker exec -i zk-postgres psql -U zk_admin -d zk_db
```

### Step 4: Verify the migration

After running the script, verify tables were created:

```sql
-- Check tables exist
SELECT table_name FROM information_schema.tables 
WHERE table_name IN ('subscription_plans', 'user_subscriptions', 'subscription_history');

-- Check ZK plans were inserted
SELECT plan_code, display_name, service_type FROM subscription_plans WHERE service_type = 'zk';

-- Check table structure
\d user_subscriptions
```

Expected output:
- `subscription_plans` table with 4 ZK plans (zk_free, zk_personal, zk_business, zk_enterprise)
- `user_subscriptions` table with columns: `service_type`, `plan_id`, `current_period_start`, etc.
- `subscription_history` table

### Step 5: Test the dashboard

1. Restart the ZK service (if needed):
   ```bash
   docker-compose restart zk-encryption-service
   ```

2. Log in as a ZK user and navigate to the Dashboard
3. The billing/plan section should now work without errors

## Troubleshooting

### Error: "relation already exists"
- The table already exists. The safe migration script handles this.
- If you get this error with the clean script, drop the table first:
  ```sql
  DROP TABLE IF EXISTS user_subscriptions CASCADE;
  ```

### Error: "permission denied"
- Make sure you're using the correct database user (`zk_admin`)
- Check database permissions

### Error: "column does not exist"
- The table might have a mixed schema
- Use the safe migration script which checks and fixes the schema

### Tables created but dashboard still fails
- Check that ZK plans exist: `SELECT * FROM subscription_plans WHERE service_type = 'zk';`
- Verify the ZK service is connecting to the correct database
- Check ZK service logs for more details

## What the Scripts Do

### Tables Created/Updated:

1. **subscription_plans**
   - Stores plan definitions for both Normal and ZK services
   - Columns: `plan_code`, `service_type`, `tier_name`, `display_name`, pricing, quotas, features, etc.

2. **user_subscriptions**
   - Tracks user subscriptions (polymorphic - works for both `users.id` and `zk_users.id`)
   - Columns: `user_id`, `service_type`, `plan_id`, `status`, billing dates, Stripe IDs, etc.

3. **subscription_history**
   - Audit trail of subscription changes
   - Tracks upgrades, downgrades, cancellations, etc.

### ZK Plans Inserted:

- `zk_free` - Free tier (2 GB)
- `zk_personal` - Personal tier ($9.99/mo, 50 GB)
- `zk_business` - Business tier ($29.99/mo, 200 GB)
- `zk_enterprise` - Enterprise tier ($99.99/mo, 1 TB)

## Notes

- The unified billing system uses `service_type` to distinguish between Normal Storage (`'normal'`) and ZK Encryption (`'zk'`) subscriptions
- Both services can use the same database or separate databases - the `BillingService` uses whatever database session is passed to it
- If you're using separate databases, make sure to run the migration on the ZK database (not the storage database)
