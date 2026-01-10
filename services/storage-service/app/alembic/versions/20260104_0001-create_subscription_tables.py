"""Create subscription tables for unified billing system

This migration creates the subscription management tables:
1. subscription_plans - Plan definitions (unified for Normal + ZK)
2. user_subscriptions - User subscription tracking
3. subscription_history - Audit trail of subscription changes

Revision ID: create_subscription_tables
Revises: separate_zk_cleanup
Create Date: 2026-01-04
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from datetime import datetime

# revision identifiers
revision = 'create_subscription_tables'
down_revision = 'add_email_verification_fields'
branch_labels = None
depends_on = None


def upgrade():
    # =========================================================================
    # 1. CREATE subscription_plans TABLE
    # =========================================================================
    
    op.create_table(
        'subscription_plans',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        
        # Plan Identity
        sa.Column('plan_code', sa.String(50), nullable=False, unique=True),
        sa.Column('service_type', sa.String(20), nullable=False),
        sa.Column('tier_name', sa.String(50), nullable=False),
        sa.Column('display_name', sa.String(100), nullable=False),
        sa.Column('description', sa.Text()),
        
        # Pricing (nullable for Phase-1)
        sa.Column('price_monthly', sa.Numeric(10, 2)),
        sa.Column('price_yearly', sa.Numeric(10, 2)),
        sa.Column('stripe_price_id_monthly', sa.String(255)),
        sa.Column('stripe_price_id_yearly', sa.String(255)),
        sa.Column('currency', sa.String(3), server_default='USD'),
        
        # Quotas and Limits
        sa.Column('storage_bytes', sa.BigInteger(), nullable=False),
        sa.Column('bandwidth_mbps', sa.Integer(), nullable=False),
        sa.Column('bandwidth_burst_mbps', sa.Integer(), nullable=False),
        sa.Column('max_concurrent_streams', sa.Integer(), nullable=False),
        
        # Feature Flags
        sa.Column('features', postgresql.JSONB(), server_default='{}'),
        
        # Metadata
        sa.Column('is_active', sa.Boolean(), nullable=False, server_default='true'),
        sa.Column('is_default', sa.Boolean(), nullable=False, server_default='false'),
        sa.Column('sort_order', sa.Integer(), server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), onupdate=sa.func.now()),
        
        # Constraints
        sa.CheckConstraint('storage_bytes > 0 OR storage_bytes = -1', name='valid_storage_quota'),
        sa.UniqueConstraint('service_type', 'tier_name', name='unique_service_tier'),
    )
    
    # Indexes for subscription_plans
    op.create_index('idx_plans_service_active', 'subscription_plans', ['service_type', 'is_active'])
    op.create_index('idx_plans_code', 'subscription_plans', ['plan_code'])
    
    # =========================================================================
    # 2. CREATE user_subscriptions TABLE
    # =========================================================================
    
    op.create_table(
        'user_subscriptions',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        
        # User Reference (polymorphic)
        sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('service_type', sa.String(20), nullable=False),
        sa.Column('plan_id', postgresql.UUID(as_uuid=True), nullable=False),
        
        # Subscription State
        sa.Column('status', sa.String(20), nullable=False, server_default='active'),
        sa.Column('billing_cycle', sa.String(20)),
        
        # Dates
        sa.Column('started_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('current_period_start', sa.DateTime(timezone=True)),
        sa.Column('current_period_end', sa.DateTime(timezone=True)),
        sa.Column('cancelled_at', sa.DateTime(timezone=True)),
        sa.Column('trial_ends_at', sa.DateTime(timezone=True)),
        
        # Stripe Integration (Phase-2)
        sa.Column('stripe_subscription_id', sa.String(255)),
        sa.Column('stripe_customer_id', sa.String(255)),
        sa.Column('payment_method', sa.String(50)),
        sa.Column('last_payment_at', sa.DateTime(timezone=True)),
        sa.Column('next_payment_at', sa.DateTime(timezone=True)),
        
        # Metadata
        sa.Column('extra_metadata', postgresql.JSONB(), server_default='{}'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column('updated_at', sa.DateTime(timezone=True), onupdate=sa.func.now()),
        
        # Foreign Keys
        sa.ForeignKeyConstraint(['plan_id'], ['subscription_plans.id']),
    )
    
    # Indexes for user_subscriptions
    op.create_index('idx_subscriptions_user', 'user_subscriptions', ['user_id', 'service_type'])
    op.create_index('idx_subscriptions_status', 'user_subscriptions', ['status'])
    op.create_index('idx_subscriptions_stripe', 'user_subscriptions', ['stripe_subscription_id'])
    
    # =========================================================================
    # 3. CREATE subscription_history TABLE
    # =========================================================================
    
    op.create_table(
        'subscription_history',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        
        # Reference
        sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column('service_type', sa.String(20), nullable=False),
        sa.Column('subscription_id', postgresql.UUID(as_uuid=True)),
        
        # Event Details
        sa.Column('event_type', sa.String(50), nullable=False),
        sa.Column('from_plan_id', postgresql.UUID(as_uuid=True)),
        sa.Column('to_plan_id', postgresql.UUID(as_uuid=True)),
        
        # Change Details
        sa.Column('reason', sa.String(100)),
        sa.Column('performed_by', postgresql.UUID(as_uuid=True)),
        sa.Column('notes', sa.Text()),
        
        # Metadata
        sa.Column('extra_metadata', postgresql.JSONB(), server_default='{}'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now()),
        
        # Foreign Keys
        sa.ForeignKeyConstraint(['subscription_id'], ['user_subscriptions.id']),
        sa.ForeignKeyConstraint(['from_plan_id'], ['subscription_plans.id']),
        sa.ForeignKeyConstraint(['to_plan_id'], ['subscription_plans.id']),
    )
    
    # Indexes for subscription_history
    op.create_index('idx_history_user', 'subscription_history', ['user_id', 'service_type'])
    op.create_index('idx_history_subscription', 'subscription_history', ['subscription_id'])
    op.create_index('idx_history_created', 'subscription_history', ['created_at'])
    
    # =========================================================================
    # 4. SEED subscription_plans WITH NORMAL STORAGE PLANS
    # =========================================================================
    
    # Insert Normal Storage plans from PLAN_LIMITS
    plans_data = [
        {
            'plan_code': 'normal_free',
            'service_type': 'normal',
            'tier_name': 'free',
            'display_name': 'Free Storage',
            'description': 'Free tier with basic storage and bandwidth',
            'price_monthly': 0,
            'price_yearly': 0,
            'storage_bytes': 5 * 1024**3,  # 5GB
            'bandwidth_mbps': 5,
            'bandwidth_burst_mbps': 10,
            'max_concurrent_streams': 2,
            'stripe_price_id_monthly': None,
            'stripe_price_id_yearly': None,
            'features': '{"support": "community", "ai_features": false}',
            'is_active': True,
            'is_default': True,
            'sort_order': 0,
        },
        {
            'plan_code': 'normal_basic',
            'service_type': 'normal',
            'tier_name': 'basic',
            'display_name': 'Basic Storage',
            'description': 'Perfect for personal use with 200GB storage',
            'price_monthly': 4.99,
            'price_yearly': 49.99,
            'storage_bytes': 200 * 1024**3,  # 200GB
            'bandwidth_mbps': 25,
            'bandwidth_burst_mbps': 50,
            'max_concurrent_streams': 5,
            'stripe_price_id_monthly': 'price_normal_basic_monthly',
            'stripe_price_id_yearly': 'price_normal_basic_yearly',
            'features': '{"support": "email", "ai_features": false, "versioning": 10}',
            'is_active': True,
            'is_default': False,
            'sort_order': 1,
        },
        {
            'plan_code': 'normal_pro',
            'service_type': 'normal',
            'tier_name': 'pro',
            'display_name': 'Pro Storage',
            'description': 'Advanced features with 1TB storage',
            'price_monthly': 9.99,
            'price_yearly': 99.99,
            'storage_bytes': 1 * 1024**4,  # 1TB
            'bandwidth_mbps': 100,
            'bandwidth_burst_mbps': 200,
            'max_concurrent_streams': 10,
            'stripe_price_id_monthly': 'price_normal_pro_monthly',
            'stripe_price_id_yearly': 'price_normal_pro_yearly',
            'features': '{"support": "priority", "ai_features": true, "versioning": 50}',
            'is_active': True,
            'is_default': False,
            'sort_order': 2,
        },
        {
            'plan_code': 'normal_team',
            'service_type': 'normal',
            'tier_name': 'team',
            'display_name': 'Team Storage',
            'description': 'Collaboration features with 5TB storage',
            'price_monthly': 24.99,
            'price_yearly': 249.99,
            'storage_bytes': 5 * 1024**4,  # 5TB
            'bandwidth_mbps': 500,
            'bandwidth_burst_mbps': 1000,
            'max_concurrent_streams': 25,
            'stripe_price_id_monthly': 'price_normal_team_monthly',
            'stripe_price_id_yearly': 'price_normal_team_yearly',
            'features': '{"support": "24/7", "ai_features": true, "versioning": 100, "team_sharing": true}',
            'is_active': True,
            'is_default': False,
            'sort_order': 3,
        },
    ]
    
    for plan in plans_data:
        op.execute(f"""
            INSERT INTO subscription_plans (
                plan_code, service_type, tier_name, display_name, description,
                price_monthly, price_yearly, storage_bytes, bandwidth_mbps,
                bandwidth_burst_mbps, max_concurrent_streams, stripe_price_id_monthly,
                stripe_price_id_yearly, features, is_active, is_default, sort_order
            ) VALUES (
                '{plan['plan_code']}', '{plan['service_type']}', '{plan['tier_name']}',
                '{plan['display_name']}', '{plan['description']}',
                {plan['price_monthly'] or 'NULL'}, {plan['price_yearly'] or 'NULL'},
                {plan['storage_bytes']}, {plan['bandwidth_mbps']}, {plan['bandwidth_burst_mbps']},
                {plan['max_concurrent_streams']},
                {f"'{plan['stripe_price_id_monthly']}'" if plan['stripe_price_id_monthly'] else 'NULL'},
                {f"'{plan['stripe_price_id_yearly']}'" if plan['stripe_price_id_yearly'] else 'NULL'},
                '{plan['features']}'::jsonb, {plan['is_active']}, {plan['is_default']}, {plan['sort_order']}
            )
        """)
    
    print("✅ Created subscription tables and seeded Normal Storage plans")


def downgrade():
    # Drop tables in reverse order (respect foreign keys)
    op.drop_table('subscription_history')
    op.drop_table('user_subscriptions')
    op.drop_table('subscription_plans')
    
    print("Dropped subscription tables")
