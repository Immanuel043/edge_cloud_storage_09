"""
SQLAlchemy models for the billing system.

These models are used by both Normal Storage and ZK Encryption services.
"""
from datetime import datetime
from typing import Optional
from uuid import UUID, uuid4

from sqlalchemy import (
    Column, String, Integer, Boolean, BigInteger, Numeric, DateTime,
    ForeignKey, Text, Index, CheckConstraint
)
from sqlalchemy.dialects.postgresql import UUID as PGUUID, JSONB
from sqlalchemy.orm import relationship, declarative_base
from sqlalchemy.sql import func

# Create a new declarative base for shared-billing models
# This allows the library to be used independently
Base = declarative_base()


class SubscriptionPlan(Base):
    """
    Subscription plan definitions (unified for Normal + ZK services).
    
    Plan codes follow the pattern: '{service_type}_{tier_name}'
    Examples: 'normal_free', 'normal_basic', 'zk_personal', 'zk_enterprise'
    """
    __tablename__ = 'subscription_plans'

    id = Column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)

    # Plan Identity
    plan_code = Column(String(50), unique=True, nullable=False, index=True)
    service_type = Column(String(20), nullable=False)  # 'normal' or 'zk'
    tier_name = Column(String(50), nullable=False)     # 'free', 'basic', 'pro', etc.
    display_name = Column(String(100), nullable=False)
    description = Column(Text)

    # Pricing (nullable for Phase-1 placeholder billing)
    price_monthly = Column(Numeric(10, 2))
    price_six_months = Column(Numeric(10, 2))  # NEW: 6-month pricing
    price_yearly = Column(Numeric(10, 2))
    stripe_price_id_monthly = Column(String(255))
    stripe_price_id_six_months = Column(String(255))  # NEW: Stripe 6-month price ID
    stripe_price_id_yearly = Column(String(255))
    razorpay_plan_id_monthly = Column(String(255))  # Razorpay plan ID for monthly
    razorpay_plan_id_six_months = Column(String(255))  # Razorpay plan ID for 6-month
    razorpay_plan_id_yearly = Column(String(255))  # Razorpay plan ID for yearly
    currency = Column(String(3), default='USD')

    # Quotas and Limits
    storage_bytes = Column(BigInteger, nullable=False)
    bandwidth_mbps = Column(Integer, nullable=False)
    bandwidth_burst_mbps = Column(Integer, nullable=False)
    max_concurrent_streams = Column(Integer, nullable=False)

    # Feature Flags (JSONB for flexibility)
    features = Column(JSONB, default={})

    # Metadata
    is_active = Column(Boolean, default=True, nullable=False)
    is_default = Column(Boolean, default=False, nullable=False)
    is_most_popular = Column(Boolean, default=False, nullable=False)  # NEW: Popular plan badge
    category = Column(String(20), default='individual', nullable=False)  # NEW: individual/business/enterprise
    sort_order = Column(Integer, default=0)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    subscriptions = relationship("UserSubscription", back_populates="plan")

    __table_args__ = (
        Index('idx_plans_service_active', 'service_type', 'is_active'),
        Index('idx_plans_code', 'plan_code'),
        CheckConstraint('storage_bytes > 0 OR storage_bytes = -1', name='valid_storage_quota'),
        {'comment': 'Unified subscription plans for Normal and ZK services'}
    )

    def __repr__(self):
        return f"<SubscriptionPlan {self.plan_code} - {self.display_name}>"


class UserSubscription(Base):
    """
    User subscription tracking (polymorphic - can link to users OR zk_users).
    
    The user_id is polymorphic: it can reference either the 'users' table
    (Normal Storage) or 'zk_users' table (ZK Encryption), determined by service_type.
    """
    __tablename__ = 'user_subscriptions'

    id = Column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)

    # User Reference (polymorphic)
    user_id = Column(PGUUID(as_uuid=True), nullable=False)
    service_type = Column(String(20), nullable=False)  # 'normal' or 'zk'
    plan_id = Column(PGUUID(as_uuid=True), ForeignKey('subscription_plans.id'), nullable=False)

    # Subscription State
    status = Column(String(20), nullable=False, default='active')
    # Status values: 'active', 'pending_payment', 'cancelled', 'expired', 'over_quota'
    billing_cycle = Column(String(20))  # 'monthly', 'yearly', NULL for free

    # Dates
    started_at = Column(DateTime(timezone=True), server_default=func.now())
    current_period_start = Column(DateTime(timezone=True))
    current_period_end = Column(DateTime(timezone=True))
    cancelled_at = Column(DateTime(timezone=True))
    trial_ends_at = Column(DateTime(timezone=True))

    # Payment Gateway Integration
    payment_gateway = Column(String(20))  # 'razorpay' or 'stripe'
    # Stripe Integration
    stripe_subscription_id = Column(String(255))
    stripe_customer_id = Column(String(255))
    # Razorpay Integration
    razorpay_subscription_id = Column(String(255))
    razorpay_order_id = Column(String(255))
    razorpay_payment_id = Column(String(255))
    # Common Payment Fields
    payment_method = Column(String(50))
    last_payment_at = Column(DateTime(timezone=True))
    next_payment_at = Column(DateTime(timezone=True))

    # Metadata
    extra_metadata = Column(JSONB, default={})
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

    # Relationships
    plan = relationship("SubscriptionPlan", back_populates="subscriptions")

    __table_args__ = (
        Index('idx_subscriptions_user', 'user_id', 'service_type'),
        Index('idx_subscriptions_status', 'status'),
        Index('idx_subscriptions_stripe', 'stripe_subscription_id'),
        Index('idx_subscriptions_razorpay', 'razorpay_subscription_id'),
        Index('idx_subscriptions_payment_gateway', 'payment_gateway'),
        # One subscription per user per service
        {'comment': 'User subscriptions for both Normal and ZK services'}
    )

    def __repr__(self):
        return f"<UserSubscription user={self.user_id} plan={self.plan.plan_code if self.plan else 'unknown'} status={self.status}>"


class SubscriptionHistory(Base):
    """
    Audit trail of subscription changes.
    
    Tracks all subscription lifecycle events for compliance and debugging.
    """
    __tablename__ = 'subscription_history'

    id = Column(PGUUID(as_uuid=True), primary_key=True, default=uuid4)

    # Reference
    user_id = Column(PGUUID(as_uuid=True), nullable=False)
    service_type = Column(String(20), nullable=False)
    subscription_id = Column(PGUUID(as_uuid=True), ForeignKey('user_subscriptions.id'))

    # Event Details
    event_type = Column(String(50), nullable=False)
    # Event types: 'created', 'upgraded', 'downgraded', 'cancelled', 'renewed', 
    #              'payment_failed', 'reactivated', 'migrated'
    from_plan_id = Column(PGUUID(as_uuid=True), ForeignKey('subscription_plans.id'))
    to_plan_id = Column(PGUUID(as_uuid=True), ForeignKey('subscription_plans.id'))

    # Change Details
    reason = Column(String(100))  # 'user_request', 'payment_failed', 'admin_action'
    performed_by = Column(PGUUID(as_uuid=True))  # admin user_id if admin action
    notes = Column(Text)

    # Metadata
    extra_metadata = Column(JSONB, default={})
    created_at = Column(DateTime(timezone=True), server_default=func.now())

    # Relationships
    from_plan = relationship("SubscriptionPlan", foreign_keys=[from_plan_id])
    to_plan = relationship("SubscriptionPlan", foreign_keys=[to_plan_id])

    __table_args__ = (
        Index('idx_history_user', 'user_id', 'service_type'),
        Index('idx_history_subscription', 'subscription_id'),
        Index('idx_history_created', 'created_at'),
        {'comment': 'Audit trail of subscription changes'}
    )

    def __repr__(self):
        return f"<SubscriptionHistory {self.event_type} user={self.user_id}>"
