"""
Pydantic schemas for billing API responses.
"""
from datetime import datetime
from decimal import Decimal
from typing import Optional, List, Dict, Any
from uuid import UUID

from pydantic import BaseModel, Field


class SubscriptionPlanSchema(BaseModel):
    """Schema for subscription plan response."""
    id: UUID
    plan_code: str
    service_type: str
    tier_name: str
    display_name: str
    description: Optional[str] = None
    
    # Pricing
    price_monthly: Optional[Decimal] = None
    price_six_months: Optional[Decimal] = None  # NEW: 6-month pricing
    price_yearly: Optional[Decimal] = None
    currency: str = "INR"
    
    # Quotas
    storage_bytes: int
    storage_gb: float = Field(description="Storage in GB (computed)")
    bandwidth_mbps: int
    bandwidth_burst_mbps: int
    max_concurrent_streams: int
    
    # Features
    features: Dict[str, Any] = {}
    
    # Metadata
    is_active: bool
    is_default: bool
    is_most_popular: bool = False  # NEW: Popular plan badge
    category: str = "individual"  # NEW: individual/business/enterprise
    sort_order: int
    
    class Config:
        from_attributes = True
    
    @classmethod
    def from_orm(cls, plan):
        """Convert SQLAlchemy model to Pydantic schema."""
        return cls(
            id=plan.id,
            plan_code=plan.plan_code,
            service_type=plan.service_type,
            tier_name=plan.tier_name,
            display_name=plan.display_name,
            description=plan.description,
            price_monthly=plan.price_monthly,
            price_six_months=plan.price_six_months,  # NEW
            price_yearly=plan.price_yearly,
            currency=plan.currency,
            storage_bytes=plan.storage_bytes,
            storage_gb=round(plan.storage_bytes / (1024**3), 2),
            bandwidth_mbps=plan.bandwidth_mbps,
            bandwidth_burst_mbps=plan.bandwidth_burst_mbps,
            max_concurrent_streams=plan.max_concurrent_streams,
            features=plan.features or {},
            is_active=plan.is_active,
            is_default=plan.is_default,
            is_most_popular=plan.is_most_popular,  # NEW
            category=plan.category,  # NEW
            sort_order=plan.sort_order,
        )


class UserSubscriptionSchema(BaseModel):
    """Schema for user subscription response."""
    id: UUID
    user_id: UUID
    service_type: str
    status: str
    billing_cycle: Optional[str] = None
    
    # Plan details (nested)
    plan: SubscriptionPlanSchema
    
    # Dates
    started_at: datetime
    current_period_start: Optional[datetime] = None
    current_period_end: Optional[datetime] = None
    cancelled_at: Optional[datetime] = None
    
    # Payment gateway
    payment_gateway: Optional[str] = None
    stripe_subscription_id: Optional[str] = None
    has_payment_method: bool = False
    next_payment_at: Optional[datetime] = None
    last_payment_at: Optional[datetime] = None

    # Price snapshot at time of purchase
    price_snapshot: Optional[Dict[str, Any]] = None

    class Config:
        from_attributes = True

    @classmethod
    def from_orm(cls, subscription):
        """Convert SQLAlchemy model to Pydantic schema."""
        return cls(
            id=subscription.id,
            user_id=subscription.user_id,
            service_type=subscription.service_type,
            status=subscription.status,
            billing_cycle=subscription.billing_cycle,
            plan=SubscriptionPlanSchema.from_orm(subscription.plan),
            started_at=subscription.started_at,
            current_period_start=subscription.current_period_start,
            current_period_end=subscription.current_period_end,
            cancelled_at=subscription.cancelled_at,
            payment_gateway=subscription.payment_gateway,
            stripe_subscription_id=subscription.stripe_subscription_id,
            has_payment_method=subscription.payment_method is not None,
            next_payment_at=subscription.next_payment_at,
            last_payment_at=subscription.last_payment_at,
            price_snapshot=subscription.price_snapshot,
        )


class SubscriptionHistorySchema(BaseModel):
    """Schema for subscription history entry."""
    id: UUID
    event_type: str
    from_plan_code: Optional[str] = None
    to_plan_code: Optional[str] = None
    reason: Optional[str] = None
    notes: Optional[str] = None
    created_at: datetime
    
    class Config:
        from_attributes = True
    
    @classmethod
    def from_orm(cls, history):
        """Convert SQLAlchemy model to Pydantic schema."""
        return cls(
            id=history.id,
            event_type=history.event_type,
            from_plan_code=history.from_plan.plan_code if history.from_plan else None,
            to_plan_code=history.to_plan.plan_code if history.to_plan else None,
            reason=history.reason,
            notes=history.notes,
            created_at=history.created_at,
        )


class InvoiceSchema(BaseModel):
    """Schema for invoice list / detail responses."""
    id: UUID
    invoice_number: str
    plan_code: str
    plan_name: str
    billing_cycle: Optional[str] = None
    amount: Decimal
    currency: str = "INR"
    status: str
    payment_gateway: Optional[str] = None
    razorpay_payment_id: Optional[str] = None
    razorpay_order_id: Optional[str] = None
    paid_at: Optional[datetime] = None
    created_at: datetime

    class Config:
        from_attributes = True

    @classmethod
    def from_orm(cls, inv):
        return cls(
            id=inv.id,
            invoice_number=inv.invoice_number,
            plan_code=inv.plan_code,
            plan_name=inv.plan_name,
            billing_cycle=inv.billing_cycle,
            amount=inv.amount,
            currency=inv.currency,
            status=inv.status,
            payment_gateway=inv.payment_gateway,
            razorpay_payment_id=inv.razorpay_payment_id,
            razorpay_order_id=inv.razorpay_order_id,
            paid_at=inv.paid_at,
            created_at=inv.created_at,
        )


class InvoiceListResponse(BaseModel):
    """Response for GET /invoices endpoint."""
    invoices: List[InvoiceSchema]
    total: int


class PlanChangePreview(BaseModel):
    """Schema for plan change preview response."""
    current_plan: SubscriptionPlanSchema
    new_plan: SubscriptionPlanSchema
    change_type: str  # 'upgrade' or 'downgrade'
    
    # Quota changes
    storage_change_gb: float
    bandwidth_change_mbps: int
    
    # Pricing (Phase-2)
    proration_amount: Optional[Decimal] = None
    next_bill_amount: Optional[Decimal] = None
    next_bill_date: Optional[datetime] = None
    
    # Warnings
    warnings: List[str] = []


class AvailablePlansResponse(BaseModel):
    """Response for GET /plans endpoint."""
    service_type: str
    plans: List[SubscriptionPlanSchema]
    current_subscription: Optional[UserSubscriptionSchema] = None
    upgrade_recommendation: Optional[Dict[str, Any]] = None


class SubscriptionResponse(BaseModel):
    """Response for subscription management endpoints."""
    subscription: UserSubscriptionSchema
    message: Optional[str] = None


class SubscriptionHistoryResponse(BaseModel):
    """Response for GET /history endpoint."""
    history: List[SubscriptionHistorySchema]
    total: int
