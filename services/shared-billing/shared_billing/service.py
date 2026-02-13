"""
Billing Service - Core business logic for subscription management.

This service provides unified subscription management for both Normal Storage
and ZK Encryption services.
"""
import logging
from datetime import datetime, timezone
from typing import List, Optional, Dict, Any, Literal
from uuid import UUID

from sqlalchemy import select, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from .models import SubscriptionPlan, UserSubscription, SubscriptionHistory
from .exceptions import (
    PlanNotFoundError,
    SubscriptionNotFoundError,
    InvalidPlanChangeError,
    QuotaExceededError,
)

logger = logging.getLogger(__name__)


class BillingService:
    """
    Unified billing service for Normal Storage and ZK Encryption.
    
    Handles all subscription lifecycle operations: creation, upgrades,
    downgrades, cancellations, and plan management.
    """
    
    def __init__(self, db: AsyncSession, service_type: Literal['normal', 'zk']):
        """
        Initialize billing service.
        
        Args:
            db: Database session
            service_type: 'normal' for Normal Storage, 'zk' for ZK Encryption
        """
        self.db = db
        self.service_type = service_type
        self.plan_prefix = f'{service_type}_'
    
    # ===== Plan Management =====
    
    async def get_available_plans(
        self, 
        active_only: bool = True,
        include_features: bool = True
    ) -> List[SubscriptionPlan]:
        """
        Get all plans for this service type.
        
        Args:
            active_only: Only return active plans
            include_features: Include feature flags
            
        Returns:
            List of subscription plans, sorted by sort_order
        """
        query = select(SubscriptionPlan).where(
            SubscriptionPlan.service_type == self.service_type
        )
        
        if active_only:
            query = query.where(SubscriptionPlan.is_active == True)
        
        query = query.order_by(SubscriptionPlan.sort_order)
        
        result = await self.db.execute(query)
        plans = result.scalars().all()
        
        logger.debug(f"Found {len(plans)} {self.service_type} plans")
        return plans
    
    async def get_plan_by_code(self, plan_code: str) -> SubscriptionPlan:
        """
        Get plan by plan code.
        
        Args:
            plan_code: Full plan code (e.g., 'normal_basic', 'zk_personal')
            
        Returns:
            SubscriptionPlan object
            
        Raises:
            PlanNotFoundError: If plan doesn't exist
        """
        result = await self.db.execute(
            select(SubscriptionPlan).where(
                SubscriptionPlan.plan_code == plan_code,
                SubscriptionPlan.is_active == True
            )
        )
        plan = result.scalar_one_or_none()
        
        if not plan:
            logger.warning(f"Plan not found: {plan_code}")
            raise PlanNotFoundError(plan_code)
        
        return plan
    
    async def get_plan_by_tier(self, tier_name: str) -> SubscriptionPlan:
        """
        Get plan by tier name for this service.
        
        Args:
            tier_name: Tier name (e.g., 'free', 'basic', 'pro')
            
        Returns:
            SubscriptionPlan object
            
        Raises:
            PlanNotFoundError: If plan doesn't exist
        """
        plan_code = f'{self.service_type}_{tier_name}'
        return await self.get_plan_by_code(plan_code)
    
    async def get_default_plan(self) -> SubscriptionPlan:
        """Get the default plan for this service (usually 'free')."""
        result = await self.db.execute(
            select(SubscriptionPlan).where(
                SubscriptionPlan.service_type == self.service_type,
                SubscriptionPlan.is_default == True,
                SubscriptionPlan.is_active == True
            )
        )
        plan = result.scalar_one_or_none()
        
        if not plan:
            # Fallback to free plan
            logger.warning(f"No default plan found, falling back to {self.service_type}_free")
            return await self.get_plan_by_tier('free')
        
        return plan
    
    # ===== Subscription Management =====
    
    async def get_user_subscription(
        self, 
        user_id: UUID,
        include_plan: bool = True
    ) -> UserSubscription:
        """
        Get user's current active subscription.
        
        Args:
            user_id: User ID
            include_plan: Eagerly load plan relationship
            
        Returns:
            UserSubscription object
            
        Raises:
            SubscriptionNotFoundError: If no subscription exists
        """
        query = select(UserSubscription).where(
            UserSubscription.user_id == user_id,
            UserSubscription.service_type == self.service_type,
            UserSubscription.status.in_(['active', 'pending_payment', 'over_quota'])
        )
        
        if include_plan:
            query = query.options(selectinload(UserSubscription.plan))
        
        result = await self.db.execute(query)
        subscription = result.scalar_one_or_none()
        
        if not subscription:
            logger.warning(f"No subscription found for user {user_id} ({self.service_type})")
            raise SubscriptionNotFoundError(str(user_id), self.service_type)
        
        return subscription
    
    async def create_subscription(
        self,
        user_id: UUID,
        plan_code: str,
        billing_cycle: Optional[str] = None,
        stripe_subscription_id: Optional[str] = None,
        stripe_customer_id: Optional[str] = None
    ) -> UserSubscription:
        """
        Create new subscription for user.
        
        Args:
            user_id: User ID
            plan_code: Plan code to subscribe to
            billing_cycle: 'monthly' or 'yearly' (None for free)
            stripe_subscription_id: Stripe subscription ID (Phase-2)
            stripe_customer_id: Stripe customer ID (Phase-2)
            
        Returns:
            Created UserSubscription
        """
        plan = await self.get_plan_by_code(plan_code)
        
        # Check if user already has a subscription
        try:
            existing = await self.get_user_subscription(user_id, include_plan=False)
            logger.warning(f"User {user_id} already has subscription {existing.id}")
            raise InvalidPlanChangeError("User already has an active subscription")
        except SubscriptionNotFoundError:
            pass  # Expected - user doesn't have subscription yet
        
        # Calculate next payment date based on billing cycle
        now = datetime.now(timezone.utc)
        next_payment_at = None
        current_period_start = now
        current_period_end = None

        if billing_cycle == 'monthly':
            from dateutil.relativedelta import relativedelta
            current_period_end = now + relativedelta(months=1)
            next_payment_at = current_period_end
        elif billing_cycle == 'six_months':
            from dateutil.relativedelta import relativedelta
            current_period_end = now + relativedelta(months=6)
            next_payment_at = current_period_end
        elif billing_cycle == 'yearly':
            from dateutil.relativedelta import relativedelta
            current_period_end = now + relativedelta(years=1)
            next_payment_at = current_period_end

        # Capture price snapshot at time of purchase
        price_snapshot = {
            'price_monthly': float(plan.price_monthly) if plan.price_monthly else None,
            'price_six_months': float(plan.price_six_months) if plan.price_six_months else None,
            'price_yearly': float(plan.price_yearly) if plan.price_yearly else None,
            'currency': plan.currency or 'INR',
            'captured_at': now.isoformat(),
        }

        # Create subscription
        subscription = UserSubscription(
            user_id=user_id,
            service_type=self.service_type,
            plan_id=plan.id,
            status='active' if not stripe_subscription_id else 'pending_payment',
            billing_cycle=billing_cycle,
            started_at=now,
            current_period_start=current_period_start,
            current_period_end=current_period_end,
            next_payment_at=next_payment_at,
            stripe_subscription_id=stripe_subscription_id,
            stripe_customer_id=stripe_customer_id,
            price_snapshot=price_snapshot,
        )
        
        self.db.add(subscription)
        
        # Record history
        history = SubscriptionHistory(
            user_id=user_id,
            service_type=self.service_type,
            subscription_id=subscription.id,
            event_type='created',
            to_plan_id=plan.id,
            reason='user_registration',
        )
        self.db.add(history)
        
        await self.db.commit()
        await self.db.refresh(subscription)
        
        # Eagerly load plan
        subscription = await self.get_user_subscription(user_id)
        
        logger.info(f"Created subscription {subscription.id} for user {user_id} (plan: {plan_code})")
        return subscription
    
    async def upgrade_subscription(
        self,
        user_id: UUID,
        new_plan_code: str,
        reason: str = 'user_request',
        performed_by: Optional[UUID] = None
    ) -> UserSubscription:
        """
        Upgrade subscription to higher tier (immediate effect).
        
        Args:
            user_id: User ID
            new_plan_code: Target plan code
            reason: Reason for upgrade
            performed_by: Admin user ID if admin action
            
        Returns:
            Updated UserSubscription
        """
        subscription = await self.get_user_subscription(user_id)
        new_plan = await self.get_plan_by_code(new_plan_code)
        old_plan = subscription.plan
        
        # Validate it's an upgrade (higher tier)
        if new_plan.sort_order <= old_plan.sort_order:
            raise InvalidPlanChangeError(
                f"Cannot upgrade from {old_plan.plan_code} to {new_plan.plan_code} (not a higher tier)"
            )
        
        # Update subscription with new plan and capture price snapshot
        now = datetime.now(timezone.utc)
        subscription.plan_id = new_plan.id
        subscription.status = 'active'
        subscription.updated_at = now
        subscription.price_snapshot = {
            'price_monthly': float(new_plan.price_monthly) if new_plan.price_monthly else None,
            'price_six_months': float(new_plan.price_six_months) if new_plan.price_six_months else None,
            'price_yearly': float(new_plan.price_yearly) if new_plan.price_yearly else None,
            'currency': new_plan.currency or 'INR',
            'captured_at': now.isoformat(),
        }

        # Record history
        history = SubscriptionHistory(
            user_id=user_id,
            service_type=self.service_type,
            subscription_id=subscription.id,
            event_type='upgraded',
            from_plan_id=old_plan.id,
            to_plan_id=new_plan.id,
            reason=reason,
            performed_by=performed_by,
        )
        self.db.add(history)
        
        await self.db.commit()
        await self.db.refresh(subscription)
        
        # Reload with plan
        subscription = await self.get_user_subscription(user_id)
        
        logger.info(f"Upgraded subscription {subscription.id}: {old_plan.plan_code} → {new_plan.plan_code}")
        return subscription
    
    async def downgrade_subscription(
        self,
        user_id: UUID,
        new_plan_code: str,
        current_usage_bytes: int = 0,
        immediate: bool = False,
        reason: str = 'user_request',
        performed_by: Optional[UUID] = None
    ) -> UserSubscription:
        """
        Downgrade subscription to lower tier.
        
        Args:
            user_id: User ID
            new_plan_code: Target plan code
            current_usage_bytes: Current storage usage
            immediate: Apply immediately (True) or at period end (False)
            reason: Reason for downgrade
            performed_by: Admin user ID if admin action
            
        Returns:
            Updated UserSubscription
            
        Raises:
            QuotaExceededError: If current usage exceeds new plan quota
        """
        subscription = await self.get_user_subscription(user_id)
        new_plan = await self.get_plan_by_code(new_plan_code)
        old_plan = subscription.plan
        
        # Validate it's a downgrade (lower tier)
        if new_plan.sort_order >= old_plan.sort_order:
            raise InvalidPlanChangeError(
                f"Cannot downgrade from {old_plan.plan_code} to {new_plan.plan_code} (not a lower tier)"
            )
        
        # Check if current usage exceeds new quota
        if current_usage_bytes > new_plan.storage_bytes and new_plan.storage_bytes != -1:
            if immediate:
                # Set status to over_quota, user can download but not upload
                subscription.status = 'over_quota'
                logger.warning(f"Downgrade for user {user_id} set to over_quota (usage exceeds quota)")
            else:
                raise QuotaExceededError(current_usage_bytes, new_plan.storage_bytes)
        
        # Update subscription
        subscription.plan_id = new_plan.id
        if immediate:
            subscription.status = 'active' if subscription.status != 'over_quota' else 'over_quota'
        subscription.updated_at = datetime.now(timezone.utc)
        
        # Record history
        history = SubscriptionHistory(
            user_id=user_id,
            service_type=self.service_type,
            subscription_id=subscription.id,
            event_type='downgraded',
            from_plan_id=old_plan.id,
            to_plan_id=new_plan.id,
            reason=reason,
            performed_by=performed_by,
            notes=f"Immediate: {immediate}, Current usage: {current_usage_bytes} bytes"
        )
        self.db.add(history)
        
        await self.db.commit()
        await self.db.refresh(subscription)
        
        # Reload with plan
        subscription = await self.get_user_subscription(user_id)
        
        logger.info(f"Downgraded subscription {subscription.id}: {old_plan.plan_code} → {new_plan.plan_code}")
        return subscription
    
    async def cancel_subscription(
        self,
        user_id: UUID,
        immediate: bool = False,
        reason: str = 'user_request'
    ) -> UserSubscription:
        """
        Cancel subscription.
        
        Args:
            user_id: User ID
            immediate: Cancel immediately (True) or at period end (False)
            reason: Cancellation reason
            
        Returns:
            Updated UserSubscription
        """
        subscription = await self.get_user_subscription(user_id)
        
        # Update status
        if immediate:
            subscription.status = 'cancelled'
        subscription.cancelled_at = datetime.now(timezone.utc)
        
        # Record history
        history = SubscriptionHistory(
            user_id=user_id,
            service_type=self.service_type,
            subscription_id=subscription.id,
            event_type='cancelled',
            from_plan_id=subscription.plan_id,
            reason=reason,
            notes=f"Immediate: {immediate}"
        )
        self.db.add(history)
        
        await self.db.commit()
        await self.db.refresh(subscription)
        
        logger.info(f"Cancelled subscription {subscription.id} (immediate: {immediate})")
        return subscription
    
    async def preview_change(
        self,
        user_id: UUID,
        new_plan_code: str
    ) -> Dict[str, Any]:
        """
        Preview subscription change without committing.
        
        Args:
            user_id: User ID
            new_plan_code: Target plan code
            
        Returns:
            Dict with preview details (quotas, pricing, warnings)
        """
        subscription = await self.get_user_subscription(user_id)
        new_plan = await self.get_plan_by_code(new_plan_code)
        current_plan = subscription.plan
        
        # Determine change type
        if new_plan.sort_order > current_plan.sort_order:
            change_type = 'upgrade'
        elif new_plan.sort_order < current_plan.sort_order:
            change_type = 'downgrade'
        else:
            change_type = 'same_tier'
        
        # Calculate quota changes
        storage_change_gb = (new_plan.storage_bytes - current_plan.storage_bytes) / (1024**3)
        bandwidth_change_mbps = new_plan.bandwidth_mbps - current_plan.bandwidth_mbps
        
        # Warnings
        warnings = []
        if change_type == 'downgrade':
            warnings.append("Downgrading may result in reduced storage and bandwidth limits.")
            warnings.append("Ensure your current usage is below the new plan's quota.")
        
        return {
            'change_type': change_type,
            'current_plan': current_plan,
            'new_plan': new_plan,
            'storage_change_gb': round(storage_change_gb, 2),
            'bandwidth_change_mbps': bandwidth_change_mbps,
            'warnings': warnings,
            # Phase-2: Add proration, next_bill_amount, next_bill_date
        }
    
    async def get_subscription_history(
        self,
        user_id: UUID,
        limit: int = 50,
        offset: int = 0
    ) -> List[SubscriptionHistory]:
        """
        Get subscription change history for user.
        
        Args:
            user_id: User ID
            limit: Max number of records
            offset: Offset for pagination
            
        Returns:
            List of SubscriptionHistory entries
        """
        query = select(SubscriptionHistory).where(
            SubscriptionHistory.user_id == user_id,
            SubscriptionHistory.service_type == self.service_type
        ).options(
            selectinload(SubscriptionHistory.from_plan),
            selectinload(SubscriptionHistory.to_plan)
        ).order_by(
            SubscriptionHistory.created_at.desc()
        ).limit(limit).offset(offset)
        
        result = await self.db.execute(query)
        history = result.scalars().all()
        
        return history
