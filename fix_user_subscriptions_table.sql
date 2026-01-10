-- Fix user_subscriptions table to match unified billing schema
-- This script updates the table structure to work with the BillingService

-- First, check if the table exists and what columns it has
-- If it doesn't exist, create it. If it exists with old schema, migrate it.

-- Step 1: Create subscription_plans table if it doesn't exist
CREATE TABLE IF NOT EXISTS subscription_plans (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    plan_code VARCHAR(50) UNIQUE NOT NULL,
    service_type VARCHAR(20) NOT NULL,
    tier_name VARCHAR(50) NOT NULL,
    display_name VARCHAR(100) NOT NULL,
    description TEXT,
    price_monthly NUMERIC(10, 2),
    price_six_months NUMERIC(10, 2),
    price_yearly NUMERIC(10, 2),
    stripe_price_id_monthly VARCHAR(255),
    stripe_price_id_six_months VARCHAR(255),
    stripe_price_id_yearly VARCHAR(255),
    currency VARCHAR(3) DEFAULT 'USD',
    storage_bytes BIGINT NOT NULL,
    bandwidth_mbps INTEGER NOT NULL,
    bandwidth_burst_mbps INTEGER NOT NULL,
    max_concurrent_streams INTEGER NOT NULL,
    features JSONB DEFAULT '{}',
    is_active BOOLEAN NOT NULL DEFAULT true,
    is_default BOOLEAN NOT NULL DEFAULT false,
    is_most_popular BOOLEAN NOT NULL DEFAULT false,
    category VARCHAR(20) DEFAULT 'individual' NOT NULL,
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT valid_storage_quota CHECK (storage_bytes > 0 OR storage_bytes = -1),
    CONSTRAINT unique_service_tier UNIQUE (service_type, tier_name)
);

CREATE INDEX IF NOT EXISTS idx_plans_service_active ON subscription_plans(service_type, is_active);
CREATE INDEX IF NOT EXISTS idx_plans_code ON subscription_plans(plan_code);

-- Step 2: Drop old user_subscriptions table if it exists with wrong schema
-- (Backup data first if needed!)
DROP TABLE IF EXISTS user_subscriptions CASCADE;

-- Step 3: Create user_subscriptions table with unified billing schema
CREATE TABLE user_subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- User Reference (polymorphic - can be users.id or zk_users.id)
    user_id UUID NOT NULL,
    service_type VARCHAR(20) NOT NULL,  -- 'normal' or 'zk'
    plan_id UUID NOT NULL REFERENCES subscription_plans(id),
    
    -- Subscription State
    status VARCHAR(20) NOT NULL DEFAULT 'active',
    billing_cycle VARCHAR(20),  -- 'monthly', 'yearly', NULL for free
    
    -- Dates
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    current_period_start TIMESTAMP WITH TIME ZONE,
    current_period_end TIMESTAMP WITH TIME ZONE,
    cancelled_at TIMESTAMP WITH TIME ZONE,
    trial_ends_at TIMESTAMP WITH TIME ZONE,
    
    -- Stripe Integration
    stripe_subscription_id VARCHAR(255),
    stripe_customer_id VARCHAR(255),
    payment_method VARCHAR(50),
    last_payment_at TIMESTAMP WITH TIME ZONE,
    next_payment_at TIMESTAMP WITH TIME ZONE,
    
    -- Metadata
    extra_metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE
);

-- Create indexes
CREATE INDEX idx_subscriptions_user ON user_subscriptions(user_id, service_type);
CREATE INDEX idx_subscriptions_status ON user_subscriptions(status);
CREATE INDEX idx_subscriptions_stripe ON user_subscriptions(stripe_subscription_id);

-- Step 4: Create subscription_history table if it doesn't exist
CREATE TABLE IF NOT EXISTS subscription_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    
    -- Reference
    user_id UUID NOT NULL,
    service_type VARCHAR(20) NOT NULL,
    subscription_id UUID REFERENCES user_subscriptions(id),
    
    -- Event Details
    event_type VARCHAR(50) NOT NULL,
    from_plan_id UUID REFERENCES subscription_plans(id),
    to_plan_id UUID REFERENCES subscription_plans(id),
    
    -- Change Details
    reason VARCHAR(100),
    performed_by UUID,
    notes TEXT,
    
    -- Metadata
    extra_metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_history_user ON subscription_history(user_id, service_type);
CREATE INDEX IF NOT EXISTS idx_history_subscription ON subscription_history(subscription_id);
CREATE INDEX IF NOT EXISTS idx_history_created ON subscription_history(created_at);

-- Step 5: Insert ZK plans if they don't exist
INSERT INTO subscription_plans (
    plan_code, service_type, tier_name, display_name, description,
    price_monthly, price_yearly, storage_bytes, bandwidth_mbps,
    bandwidth_burst_mbps, max_concurrent_streams, features,
    is_active, is_default, sort_order
) VALUES
(
    'zk_free', 'zk', 'free', 'ZK Free Tier',
    'Zero-knowledge encrypted storage with basic features. Client-side encryption for maximum privacy.',
    NULL, NULL,
    2147483648,  -- 2 GB
    3, 5, 1,
    '{"support": "community", "encryption": "zero_knowledge", "hardware_keys": 2, "recovery_phrase": true, "webauthn": true}'::jsonb,
    TRUE, TRUE, 100
),
(
    'zk_personal', 'zk', 'personal', 'ZK Personal',
    'Personal zero-knowledge vault with enhanced storage and features. Full client-side encryption.',
    9.99, 99.99,
    53687091200,  -- 50 GB
    10, 20, 3,
    '{"support": "email", "encryption": "zero_knowledge", "hardware_keys": 5, "recovery_phrase": true, "webauthn": true, "versioning": true}'::jsonb,
    TRUE, FALSE, 101
),
(
    'zk_business', 'zk', 'business', 'ZK Business',
    'Business-grade zero-knowledge encryption with priority support and advanced security features.',
    29.99, 299.99,
    214748364800,  -- 200 GB
    50, 100, 10,
    '{"support": "priority", "encryption": "zero_knowledge", "hardware_keys": 10, "recovery_phrase": true, "webauthn": true, "versioning": true, "audit_logs": true, "team_sharing": true}'::jsonb,
    TRUE, FALSE, 102
),
(
    'zk_enterprise', 'zk', 'enterprise', 'ZK Enterprise',
    'Enterprise zero-knowledge solution with unlimited storage and dedicated support.',
    99.99, 999.99,
    1099511627776,  -- 1 TB
    200, 500, 50,
    '{"support": "dedicated", "encryption": "zero_knowledge", "hardware_keys": 50, "recovery_phrase": true, "webauthn": true, "versioning": true, "audit_logs": true, "team_sharing": true, "sso": true, "compliance": true}'::jsonb,
    TRUE, FALSE, 103
)
ON CONFLICT (plan_code) DO NOTHING;

-- Verify tables were created
SELECT 'Tables created successfully!' AS status;
SELECT COUNT(*) AS subscription_plans_count FROM subscription_plans WHERE service_type = 'zk';
SELECT COUNT(*) AS user_subscriptions_count FROM user_subscriptions;
