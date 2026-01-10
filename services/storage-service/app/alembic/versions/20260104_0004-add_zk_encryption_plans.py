"""Add ZK Encryption service plans

Revision ID: add_zk_encryption_plans
Revises: migrate_existing_subscriptions
Create Date: 2026-01-04
"""
from alembic import op
import sqlalchemy as sa
from datetime import datetime

# revision identifiers
revision = 'add_zk_encryption_plans'
down_revision = 'migrate_existing_subscriptions'
branch_labels = None
depends_on = None


def upgrade():
    # Insert ZK Encryption plans
    op.execute("""
        INSERT INTO subscription_plans (
            plan_code,
            service_type,
            tier_name,
            display_name,
            description,
            price_monthly,
            price_yearly,
            storage_bytes,
            bandwidth_mbps,
            bandwidth_burst_mbps,
            max_concurrent_streams,
            features,
            is_active,
            is_default,
            sort_order,
            created_at
        ) VALUES
        (
            'zk_free',
            'zk',
            'Free',
            'ZK Free Tier',
            'Zero-knowledge encrypted storage with basic features. Client-side encryption for maximum privacy.',
            NULL,
            NULL,
            2147483648,  -- 2 GB (less than normal free due to encryption overhead)
            3,           -- 3 Mbps
            5,           -- 5 Mbps burst
            1,           -- 1 concurrent stream
            '{"support": "community", "encryption": "zero_knowledge", "hardware_keys": 2, "recovery_phrase": true, "webauthn": true}'::jsonb,
            TRUE,
            TRUE,
            100,
            NOW()
        ),
        (
            'zk_personal',
            'zk',
            'Personal',
            'ZK Personal',
            'Personal zero-knowledge vault with enhanced storage and features. Full client-side encryption.',
            9.99,
            99.99,
            53687091200, -- 50 GB
            10,          -- 10 Mbps
            20,          -- 20 Mbps burst
            3,           -- 3 concurrent streams
            '{"support": "email", "encryption": "zero_knowledge", "hardware_keys": 5, "recovery_phrase": true, "webauthn": true, "versioning": true}'::jsonb,
            TRUE,
            FALSE,
            101,
            NOW()
        ),
        (
            'zk_business',
            'zk',
            'Business',
            'ZK Business',
            'Business-grade zero-knowledge encryption with priority support and advanced security features.',
            29.99,
            299.99,
            214748364800, -- 200 GB
            50,           -- 50 Mbps
            100,          -- 100 Mbps burst
            10,           -- 10 concurrent streams
            '{"support": "priority", "encryption": "zero_knowledge", "hardware_keys": 10, "recovery_phrase": true, "webauthn": true, "versioning": true, "audit_logs": true, "team_sharing": true}'::jsonb,
            TRUE,
            FALSE,
            102,
            NOW()
        ),
        (
            'zk_enterprise',
            'zk',
            'Enterprise',
            'ZK Enterprise',
            'Enterprise zero-knowledge solution with unlimited storage and dedicated support.',
            99.99,
            999.99,
            1099511627776, -- 1 TB
            200,           -- 200 Mbps
            500,           -- 500 Mbps burst
            50,            -- 50 concurrent streams
            '{"support": "dedicated", "encryption": "zero_knowledge", "hardware_keys": 50, "recovery_phrase": true, "webauthn": true, "versioning": true, "audit_logs": true, "team_sharing": true, "sso": true, "compliance": true}'::jsonb,
            TRUE,
            FALSE,
            103,
            NOW()
        )
    """)

    print("✅ Added 4 ZK Encryption plans (zk_free, zk_personal, zk_business, zk_enterprise)")


def downgrade():
    # Remove ZK plans
    op.execute("""
        DELETE FROM subscription_plans
        WHERE service_type = 'zk'
        AND plan_code IN ('zk_free', 'zk_personal', 'zk_business', 'zk_enterprise')
    """)

    print("Removed ZK Encryption plans")
