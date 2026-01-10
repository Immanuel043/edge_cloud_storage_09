"""
Subscription UI Helper Endpoints

Provides convenient endpoints specifically designed for frontend consumption.
These endpoints combine data from multiple sources to reduce frontend API calls.
"""
import logging
from typing import Optional, List, Dict, Any
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from pydantic import BaseModel, Field

from shared_billing import BillingService, SubscriptionPlan, UserSubscription
from shared_billing.schemas import SubscriptionPlanSchema, UserSubscriptionSchema
from shared_billing.exceptions import SubscriptionNotFoundError

from ..dependencies import get_db, get_current_user
from ..models.database import ZKUser as User

logger = logging.getLogger(__name__)
router = APIRouter(tags=["subscription-ui"])


# ===== Response Models =====

class PlanFeature(BaseModel):
    """Individual plan feature for display."""
    name: str
    description: str
    available: bool
    tooltip: Optional[str] = None


class PlanCard(BaseModel):
    """Plan information formatted for UI card display."""
    plan_code: str
    display_name: str
    tier_name: str
    description: Optional[str]

    # Pricing
    price_monthly: Optional[float]
    price_six_months: Optional[float] = None  # NEW: 6-month pricing
    price_yearly: Optional[float]
    price_display: str  # e.g., "Free", "$9.99/mo", "$99/yr"

    # Quotas (human-readable)
    storage_gb: float
    bandwidth_mbps: int
    max_streams: int

    # Features
    features: List[PlanFeature]

    # Status
    is_current: bool
    is_upgrade: bool
    is_downgrade: bool
    is_active: bool

    # NEW: Plan metadata
    tier: int = 0  # sort_order for tier comparison
    category: str = "individual"  # individual/business/enterprise
    is_most_popular: bool = False

    # UI hints
    badge: Optional[str] = None  # e.g., "Most Popular", "Best Value"
    highlight: bool = False


class UserSubscriptionStatus(BaseModel):
    """Current user subscription status with usage info."""
    # Subscription info
    plan_code: str
    plan_name: str
    status: str
    started_at: str

    # Pricing (frontend expects these)
    price_display: Optional[str] = None
    next_billing_date: Optional[str] = None

    # Plan tier for comparison (frontend needs this)
    tier: int = 0  # sort_order used for tier comparison

    # Usage
    storage_used_gb: float
    storage_quota_gb: float
    storage_percent: float

    bandwidth_used_mbps: Optional[float] = None
    bandwidth_quota_mbps: int

    # Status indicators
    is_trial: bool = False
    is_past_due: bool = False
    is_cancelled: bool = False
    days_until_renewal: Optional[int] = None

    # Actions available
    can_upgrade: bool
    can_downgrade: bool
    can_cancel: bool


class SubscriptionDashboard(BaseModel):
    """Complete dashboard data in single response."""
    # Frontend expects these field names
    subscription: UserSubscriptionStatus
    available_plans: List[PlanCard]
    usage: Optional[Dict[str, Any]] = None  # Match frontend expectation
    warnings: List[Dict[str, Any]]
    recommendations: List[Dict[str, Any]]


# ===== Helper Functions =====

def format_plan_features(plan: SubscriptionPlan, service_type: str = 'normal') -> List[PlanFeature]:
    """Convert plan features dict to structured list for UI."""
    features = []

    # Storage
    storage_gb = plan.storage_bytes / (1024**3)
    features.append(PlanFeature(
        name="Storage",
        description=f"{storage_gb:.0f} GB cloud storage",
        available=True,
        tooltip="Total file storage capacity"
    ))

    # Bandwidth
    features.append(PlanFeature(
        name="Bandwidth",
        description=f"{plan.bandwidth_mbps} Mbps transfer speed",
        available=True,
        tooltip="Upload/download speed limit"
    ))

    # Concurrent streams
    features.append(PlanFeature(
        name="Concurrent Uploads",
        description=f"{plan.max_concurrent_streams} simultaneous transfers",
        available=True,
        tooltip="Number of files you can upload at once"
    ))

    # Parse features from JSONB
    if plan.features:
        # Support type
        if 'support' in plan.features:
            support_type = plan.features['support']
            support_map = {
                'community': ('Community Support', 'Forum and documentation', False),
                'email': ('Email Support', '24/7 email support', True),
                'priority': ('Priority Support', 'Priority email + chat', True),
                'dedicated': ('Dedicated Support', 'Dedicated support engineer', True),
            }
            if support_type in support_map:
                name, desc, avail = support_map[support_type]
                features.append(PlanFeature(
                    name=name,
                    description=desc,
                    available=avail
                ))

        # Versioning
        if plan.features.get('versioning'):
            features.append(PlanFeature(
                name="File Versioning",
                description="Keep previous versions of files",
                available=True,
                tooltip="Restore old versions of your files"
            ))

        # AI Features
        if plan.features.get('ai_features'):
            features.append(PlanFeature(
                name="AI Features",
                description="Smart search and auto-tagging",
                available=True,
                tooltip="AI-powered file organization"
            ))

        # Team Sharing
        if plan.features.get('team_sharing'):
            features.append(PlanFeature(
                name="Team Sharing",
                description="Collaborate with team members",
                available=True
            ))

        # ZK-specific features
        if service_type == 'zk':
            if 'hardware_keys' in plan.features:
                num_keys = plan.features['hardware_keys']
                features.append(PlanFeature(
                    name="Hardware Keys",
                    description=f"Up to {num_keys} security keys",
                    available=True,
                    tooltip="WebAuthn/FIDO2 hardware security keys"
                ))

            if plan.features.get('webauthn'):
                features.append(PlanFeature(
                    name="WebAuthn",
                    description="Biometric & security key login",
                    available=True
                ))

            if plan.features.get('audit_logs'):
                features.append(PlanFeature(
                    name="Audit Logs",
                    description="Complete access history",
                    available=True
                ))

    return features


def get_plan_badge(plan: SubscriptionPlan) -> Optional[str]:
    """Determine if plan should have a badge."""
    # Use is_most_popular flag from database
    if plan.is_most_popular:
        return 'Most Popular'

    # Legacy fallback for specific plans
    legacy_badges = {
        'normal_pro': 'Best Value',
        'zk_business': 'Best Value',
    }
    return legacy_badges.get(plan.plan_code)


# ===== Endpoints =====

@router.get("/dashboard", response_model=SubscriptionDashboard)
async def get_subscription_dashboard(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get complete subscription dashboard in a single request.

    Returns:
    - Current subscription status with usage
    - All available plans formatted for UI cards
    - Usage warnings
    - Upgrade recommendations
    """
    billing = BillingService(db, service_type='zk')

    # Get user's subscription
    try:
        subscription = await billing.get_user_subscription(current_user.id, include_plan=True)
    except SubscriptionNotFoundError:
        # If no subscription exists, create ZK Pro tier (ZK service has no free tier)
        subscription = await billing.create_subscription(current_user.id, 'zk_pro')

    plan = subscription.plan

    # Calculate usage percentages
    storage_used_gb = current_user.storage_used / (1024**3)
    storage_quota_gb = plan.storage_bytes / (1024**3)
    storage_percent = (current_user.storage_used / plan.storage_bytes * 100) if plan.storage_bytes > 0 else 0

    # Format price display
    if plan.price_monthly is None or plan.price_monthly == 0:
        price_display = "Free"
    else:
        price_display = f"${float(plan.price_monthly):.2f}/mo"

    # Format next billing date
    next_billing_date = None
    if subscription.current_period_end:
        next_billing_date = subscription.current_period_end.isoformat()

    # Current subscription status
    current_sub = UserSubscriptionStatus(
        plan_code=plan.plan_code,
        plan_name=plan.display_name,
        status=subscription.status,
        started_at=subscription.started_at.isoformat() if subscription.started_at else "",
        price_display=price_display,
        next_billing_date=next_billing_date,
        tier=plan.sort_order,  # Use sort_order as tier for comparison
        storage_used_gb=round(storage_used_gb, 2),
        storage_quota_gb=round(storage_quota_gb, 2),
        storage_percent=round(storage_percent, 1),
        bandwidth_quota_mbps=plan.bandwidth_mbps,
        is_past_due=(subscription.status == 'past_due'),
        is_cancelled=(subscription.status == 'cancelled'),
        can_upgrade=(plan.sort_order < 3),  # Can upgrade if not on highest tier
        can_downgrade=(plan.sort_order > 0),
        can_cancel=(subscription.status == 'active')
    )

    # Get all available plans
    all_plans = await billing.get_available_plans()

    plan_cards = []
    for p in all_plans:
        # Determine relationship to current plan
        is_current = (p.plan_code == plan.plan_code)
        is_upgrade = (p.sort_order > plan.sort_order)
        is_downgrade = (p.sort_order < plan.sort_order)

        # Format price display
        if p.price_monthly is None or p.price_monthly == 0:
            price_display = "Free"
        else:
            price_display = f"${p.price_monthly:.2f}/mo"

        plan_card = PlanCard(
            plan_code=p.plan_code,
            display_name=p.display_name,
            tier_name=p.tier_name,
            description=p.description,
            price_monthly=p.price_monthly,
            price_six_months=p.price_six_months,  # NEW
            price_yearly=p.price_yearly,
            price_display=price_display,
            storage_gb=round(p.storage_bytes / (1024**3), 0),
            bandwidth_mbps=p.bandwidth_mbps,
            max_streams=p.max_concurrent_streams,
            features=format_plan_features(p, 'zk'),
            is_current=is_current,
            is_upgrade=is_upgrade,
            is_downgrade=is_downgrade,
            is_active=p.is_active,
            tier=p.sort_order,  # NEW: Use sort_order as tier
            category=p.category,  # NEW
            is_most_popular=p.is_most_popular,  # NEW
            badge=get_plan_badge(p),  # Use new function signature
            highlight=(p.is_most_popular or p.plan_code == 'normal_basic')  # Highlight most popular plans
        )
        plan_cards.append(plan_card)

    # Usage warnings
    warnings = []
    if storage_percent > 80:
        warnings.append({
            "type": "storage",
            "severity": "high" if storage_percent > 95 else "medium",
            "message": f"You've used {storage_percent:.1f}% of your storage",
            "action": "Consider upgrading to get more space"
        })

    # Recommendations
    recommendations = []
    if storage_percent > 80 and plan.sort_order < 3:
        next_plan = next((p for p in all_plans if p.sort_order == plan.sort_order + 1), None)
        if next_plan:
            recommendations.append({
                "type": "upgrade",
                "plan_code": next_plan.plan_code,
                "message": f"Upgrade to {next_plan.display_name} for {next_plan.storage_bytes / (1024**3):.0f}GB",
                "benefit": f"Get {(next_plan.storage_bytes - plan.storage_bytes) / (1024**3):.0f}GB more storage"
            })

    # Build usage dictionary matching frontend expectation
    usage_dict = {
        "storage_used_bytes": current_user.storage_used,
        "storage_used_gb": storage_used_gb,
        "storage_used_display": f"{storage_used_gb:.1f} GB",
        "storage_quota_gb": storage_quota_gb,
        "storage_quota_display": f"{storage_quota_gb:.0f} GB",
        "storage_percent": storage_percent,
        "bandwidth_quota_mbps": plan.bandwidth_mbps,
        "bandwidth_quota_display": f"{plan.bandwidth_mbps} Mbps"
    }

    return SubscriptionDashboard(
        subscription=current_sub,
        available_plans=plan_cards,
        usage=usage_dict,
        warnings=warnings,
        recommendations=recommendations
    )


@router.get("/plans/compare")
async def compare_plans(
    plan_codes: str,  # Comma-separated plan codes
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Compare multiple plans side-by-side.

    Args:
        plan_codes: Comma-separated list of plan codes (e.g., "zk_pro,zk_pro_plus,zk_ultra")

    Returns:
        Detailed comparison table data
    """
    codes = [code.strip() for code in plan_codes.split(',')]

    billing = BillingService(db, service_type='zk')
    plans = []

    for code in codes:
        try:
            plan = await billing.get_plan_by_code(code)
            plans.append(plan)
        except:
            continue

    if not plans:
        raise HTTPException(404, "No valid plans found")

    # Build comparison matrix
    comparison = {
        "plans": [
            {
                "plan_code": p.plan_code,
                "display_name": p.display_name,
                "price_monthly": p.price_monthly,
                "price_yearly": p.price_yearly,
            }
            for p in plans
        ],
        "features": {
            "storage": [f"{p.storage_bytes / (1024**3):.0f} GB" for p in plans],
            "bandwidth": [f"{p.bandwidth_mbps} Mbps" for p in plans],
            "max_streams": [str(p.max_concurrent_streams) for p in plans],
            "support": [p.features.get('support', 'community') if p.features else 'community' for p in plans],
            "versioning": [p.features.get('versioning', False) if p.features else False for p in plans],
            "ai_features": [p.features.get('ai_features', False) if p.features else False for p in plans],
        }
    }

    return comparison


@router.get("/usage/summary")
async def get_usage_summary(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Get usage summary optimized for progress bars and charts.
    """
    billing = BillingService(db, service_type='zk')

    try:
        subscription = await billing.get_user_subscription(current_user.id, include_plan=True)
    except:
        subscription = await billing.create_subscription(current_user.id, 'zk_pro')

    plan = subscription.plan

    storage_used_bytes = current_user.storage_used
    storage_quota_bytes = plan.storage_bytes
    storage_percent = (storage_used_bytes / storage_quota_bytes * 100) if storage_quota_bytes > 0 else 0

    # Determine progress bar color
    if storage_percent < 50:
        storage_color = "success"
    elif storage_percent < 80:
        storage_color = "warning"
    else:
        storage_color = "danger"

    return {
        "storage": {
            "used_bytes": storage_used_bytes,
            "used_gb": round(storage_used_bytes / (1024**3), 2),
            "quota_bytes": storage_quota_bytes,
            "quota_gb": round(storage_quota_bytes / (1024**3), 2),
            "percent": round(storage_percent, 1),
            "color": storage_color,
            "display": f"{storage_used_bytes / (1024**3):.1f} GB / {storage_quota_bytes / (1024**3):.0f} GB"
        },
        "bandwidth": {
            "quota_mbps": plan.bandwidth_mbps,
            "burst_mbps": plan.bandwidth_burst_mbps,
            "max_streams": plan.max_concurrent_streams
        },
        "plan": {
            "code": plan.plan_code,
            "name": plan.display_name,
            "tier": plan.tier_name
        }
    }
