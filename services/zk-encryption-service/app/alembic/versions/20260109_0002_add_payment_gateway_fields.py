"""Add payment gateway fields for Razorpay and Stripe support

Revision ID: 20260109_0002
Revises: update_plans_schema
Create Date: 2026-01-09

Adds Razorpay plan IDs and payment_gateway field to support multiple payment gateways.
Users can choose between Razorpay and Stripe for subscription payments.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers
revision = '20260109_0002'
down_revision = 'update_plans_schema'
branch_labels = None
depends_on = None


def upgrade():
    # =========================================================================
    # Add Razorpay fields to subscription_plans table
    # =========================================================================
    op.add_column(
        'subscription_plans',
        sa.Column('razorpay_plan_id_monthly', sa.String(255), nullable=True)
    )
    op.add_column(
        'subscription_plans',
        sa.Column('razorpay_plan_id_six_months', sa.String(255), nullable=True)
    )
    op.add_column(
        'subscription_plans',
        sa.Column('razorpay_plan_id_yearly', sa.String(255), nullable=True)
    )
    
    # =========================================================================
    # Add Razorpay and payment_gateway fields to user_subscriptions table
    # =========================================================================
    op.add_column(
        'user_subscriptions',
        sa.Column('razorpay_subscription_id', sa.String(255), nullable=True)
    )
    op.add_column(
        'user_subscriptions',
        sa.Column('razorpay_order_id', sa.String(255), nullable=True)
    )
    op.add_column(
        'user_subscriptions',
        sa.Column('razorpay_payment_id', sa.String(255), nullable=True)
    )
    op.add_column(
        'user_subscriptions',
        sa.Column('payment_gateway', sa.String(20), nullable=True, comment="'razorpay' or 'stripe'")
    )
    
    # Create index for payment_gateway
    op.create_index(
        'idx_subscriptions_payment_gateway',
        'user_subscriptions',
        ['payment_gateway']
    )
    
    # Create index for Razorpay subscription ID
    op.create_index(
        'idx_subscriptions_razorpay',
        'user_subscriptions',
        ['razorpay_subscription_id']
    )
    
    print("✅ Added payment gateway fields (Razorpay + payment_gateway)")


def downgrade():
    # Drop indexes
    op.drop_index('idx_subscriptions_razorpay', 'user_subscriptions')
    op.drop_index('idx_subscriptions_payment_gateway', 'user_subscriptions')
    
    # Drop columns from user_subscriptions
    op.drop_column('user_subscriptions', 'payment_gateway')
    op.drop_column('user_subscriptions', 'razorpay_payment_id')
    op.drop_column('user_subscriptions', 'razorpay_order_id')
    op.drop_column('user_subscriptions', 'razorpay_subscription_id')
    
    # Drop columns from subscription_plans
    op.drop_column('subscription_plans', 'razorpay_plan_id_yearly')
    op.drop_column('subscription_plans', 'razorpay_plan_id_six_months')
    op.drop_column('subscription_plans', 'razorpay_plan_id_monthly')
    
    print("Dropped payment gateway fields")
