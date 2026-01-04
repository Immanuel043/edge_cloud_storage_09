"""
Custom exceptions for the billing service.
"""


class BillingException(Exception):
    """Base exception for billing-related errors."""
    pass


class PlanNotFoundError(BillingException):
    """Raised when a requested plan does not exist."""
    def __init__(self, plan_code: str):
        self.plan_code = plan_code
        super().__init__(f"Plan not found: {plan_code}")


class SubscriptionNotFoundError(BillingException):
    """Raised when a user's subscription is not found."""
    def __init__(self, user_id: str, service_type: str):
        self.user_id = user_id
        self.service_type = service_type
        super().__init__(f"No subscription found for user {user_id} ({service_type} service)")


class InvalidPlanChangeError(BillingException):
    """Raised when a plan change is invalid (e.g., downgrade would exceed quota)."""
    pass


class QuotaExceededError(BillingException):
    """Raised when user tries to downgrade below their current usage."""
    def __init__(self, current_usage: int, new_quota: int):
        self.current_usage = current_usage
        self.new_quota = new_quota
        super().__init__(
            f"Cannot downgrade: current usage ({current_usage} bytes) exceeds new quota ({new_quota} bytes)"
        )
