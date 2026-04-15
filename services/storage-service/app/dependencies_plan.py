# services/storage-service/app/dependencies_plan.py
"""Plan-feature gating dependencies.

Provides a ``require_plan_feature(feature_key)`` factory that returns a
FastAPI dependency. Protected endpoints return HTTP 402 Payment Required
when the current user's plan does not have the requested feature flag set
in ``plan.features`` (JSONB).

Why this lives in its own module rather than ``dependencies.py``:
- Keeps the core auth path (``get_current_user``, ``get_db``) free of
  billing-service imports (cheaper startup, easier to test in isolation).
- Makes it obvious at every usage site that the route is gated by plan.

The feature keys match the JSONB shape already returned by shared_billing
and already referenced from ``subscription_helpers.format_plan_features``:
``ai_features``, ``versioning``, ``team_sharing``, ``audit_logs``, etc.
"""
import logging

from fastapi import Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from shared_billing import BillingService, SubscriptionNotFoundError

from .dependencies import get_current_user, get_db
from .models.database import User

logger = logging.getLogger(__name__)


def require_plan_feature(feature_key: str):
    """Return a FastAPI dependency that enforces ``plan.features[feature_key]``.

    If the user has no subscription yet, we auto-create a free tier
    (consistent with subscription_helpers.get_subscription_dashboard) and
    then check — which reliably 402s free users while still letting the
    caller short-circuit for paid users on the first request.
    """

    async def _checker(
        current_user: User = Depends(get_current_user),
        db: AsyncSession = Depends(get_db),
    ) -> User:
        billing = BillingService(db, service_type="normal")
        try:
            sub = await billing.get_user_subscription(
                current_user.id, include_plan=True
            )
        except SubscriptionNotFoundError:
            # Parity with subscription_helpers — missing subscription => free.
            sub = await billing.create_subscription(current_user.id, "normal_free")

        features = getattr(sub.plan, "features", None) or {}
        if not features.get(feature_key):
            logger.info(
                "plan_gate_denied user_id=%s plan=%s feature=%s",
                current_user.id,
                getattr(sub.plan, "plan_code", "?"),
                feature_key,
            )
            raise HTTPException(
                status_code=status.HTTP_402_PAYMENT_REQUIRED,
                detail=(
                    f"This feature requires a plan with '{feature_key}'. "
                    f"Please upgrade your subscription."
                ),
            )
        return current_user

    # Give the closure a stable, informative name for FastAPI docs + logs.
    _checker.__name__ = f"require_plan_feature__{feature_key}"
    return _checker
