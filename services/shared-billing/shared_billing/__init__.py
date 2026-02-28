"""
Shared Billing Library for Edge Cloud Storage

Provides unified subscription management for both Normal Storage
and ZK Encryption services.
"""

__version__ = "1.0.0"

from .models import SubscriptionPlan, UserSubscription, SubscriptionHistory, Invoice
from .service import BillingService
from .payment_service import PaymentService
from .razorpay_service import RazorpayService
from .stripe_service import StripeService
from .webhook_idempotency import WebhookIdempotencyService, WebhookEvent, WEBHOOK_IP_WHITELIST
from .audit_logger import AuditLogger, AuditLog, AuditEventType
from .exceptions import (
    BillingException,
    PlanNotFoundError,
    SubscriptionNotFoundError,
    InvalidPlanChangeError,
    QuotaExceededError,
)

__all__ = [
    "SubscriptionPlan",
    "UserSubscription",
    "SubscriptionHistory",
    "Invoice",
    "BillingService",
    "PaymentService",
    "RazorpayService",
    "StripeService",
    "WebhookIdempotencyService",
    "WebhookEvent",
    "WEBHOOK_IP_WHITELIST",
    "AuditLogger",
    "AuditLog",
    "AuditEventType",
    "BillingException",
    "PlanNotFoundError",
    "SubscriptionNotFoundError",
    "InvalidPlanChangeError",
    "QuotaExceededError",
]

# Import validators
from .validators import BillingValidator, InputSanitizer, ValidationError

# Add to __all__
__all__.extend(["BillingValidator", "InputSanitizer", "ValidationError"])

# Import trial manager
from .trial_manager import TrialManager

# Add to __all__
__all__.append("TrialManager")

# Import refund manager
from .refund_manager import RefundManager, Refund, RefundReason, RefundStatus

# Add to __all__
__all__.extend(["RefundManager", "Refund", "RefundReason", "RefundStatus"])

# Import reconciliation service
from .reconciliation import (
    ReconciliationService,
    ReconciliationResult,
    Discrepancy,
    DiscrepancyType,
    ReconciliationAction,
    run_daily_reconciliation
)

# Add to __all__
__all__.extend([
    "ReconciliationService",
    "ReconciliationResult",
    "Discrepancy",
    "DiscrepancyType",
    "ReconciliationAction",
    "run_daily_reconciliation"
])

# Import proration service
from .proration import (
    ProrationService,
    ProrationCalculation,
    ProrationStrategy,
    BillingPeriod
)

# Add to __all__
__all__.extend([
    "ProrationService",
    "ProrationCalculation",
    "ProrationStrategy",
    "BillingPeriod"
])
