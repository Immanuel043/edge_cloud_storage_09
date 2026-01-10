"""
Input Validation and Sanitization for Billing Operations

Prevents injection attacks, validates business rules, and ensures data integrity.

Security Protections:
- SQL injection prevention
- XSS prevention
- CSRF protection (handled by FastAPI)
- Business rule validation
- Data type validation
"""

import re
from typing import Optional, Any
from decimal import Decimal, InvalidOperation
from datetime import datetime
from uuid import UUID


class ValidationError(Exception):
    """Custom exception for validation errors."""
    pass


class BillingValidator:
    """
    Comprehensive validation for billing inputs.

    All user inputs MUST be validated before processing.
    """

    # Regex patterns
    EMAIL_PATTERN = re.compile(r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$')
    PLAN_CODE_PATTERN = re.compile(r'^[a-z_]{3,50}$')
    GATEWAY_PATTERN = re.compile(r'^(stripe|razorpay)$')
    BILLING_CYCLE_PATTERN = re.compile(r'^(monthly|six_months|yearly)$')
    CURRENCY_PATTERN = re.compile(r'^[A-Z]{3}$')
    STATUS_PATTERN = re.compile(r'^(active|cancelled|pending|expired|trial|pending_payment)$')

    # Business rules
    MIN_AMOUNT = Decimal('0.01')
    MAX_AMOUNT = Decimal('1000000.00')  # 1 million max
    MAX_STRING_LENGTH = 255
    MAX_TEXT_LENGTH = 10000

    @staticmethod
    def validate_email(email: Optional[str], field_name: str = "email") -> str:
        """
        Validate email address format.

        Args:
            email: Email address to validate
            field_name: Name of field for error messages

        Returns:
            Sanitized email

        Raises:
            ValidationError: If email is invalid
        """
        if not email:
            raise ValidationError(f"{field_name} is required")

        email = email.strip().lower()

        if len(email) > BillingValidator.MAX_STRING_LENGTH:
            raise ValidationError(f"{field_name} is too long (max {BillingValidator.MAX_STRING_LENGTH} characters)")

        if not BillingValidator.EMAIL_PATTERN.match(email):
            raise ValidationError(f"{field_name} is not a valid email address")

        return email

    @staticmethod
    def validate_plan_code(plan_code: Optional[str]) -> str:
        """
        Validate plan code format.

        Plan codes must be lowercase alphanumeric with underscores only.
        """
        if not plan_code:
            raise ValidationError("plan_code is required")

        plan_code = plan_code.strip().lower()

        if not BillingValidator.PLAN_CODE_PATTERN.match(plan_code):
            raise ValidationError(
                "plan_code must be 3-50 characters, lowercase letters and underscores only"
            )

        return plan_code

    @staticmethod
    def validate_gateway(gateway: Optional[str]) -> str:
        """
        Validate payment gateway.

        Only 'stripe' and 'razorpay' are supported.
        """
        if not gateway:
            raise ValidationError("payment_gateway is required")

        gateway = gateway.strip().lower()

        if not BillingValidator.GATEWAY_PATTERN.match(gateway):
            raise ValidationError("payment_gateway must be 'stripe' or 'razorpay'")

        return gateway

    @staticmethod
    def validate_billing_cycle(billing_cycle: Optional[str]) -> str:
        """
        Validate billing cycle.

        Only 'monthly', 'six_months', and 'yearly' are supported.
        """
        if not billing_cycle:
            raise ValidationError("billing_cycle is required")

        billing_cycle = billing_cycle.strip().lower()

        if not BillingValidator.BILLING_CYCLE_PATTERN.match(billing_cycle):
            raise ValidationError("billing_cycle must be 'monthly', 'six_months', or 'yearly'")

        return billing_cycle

    @staticmethod
    def validate_currency(currency: Optional[str]) -> str:
        """
        Validate currency code (ISO 4217).

        Must be 3-letter uppercase code (e.g., USD, EUR, INR).
        """
        if not currency:
            raise ValidationError("currency is required")

        currency = currency.strip().upper()

        if not BillingValidator.CURRENCY_PATTERN.match(currency):
            raise ValidationError("currency must be a 3-letter ISO code (e.g., USD, EUR, INR)")

        # Validate against supported currencies
        supported = ['USD', 'EUR', 'INR', 'GBP', 'CAD', 'AUD']
        if currency not in supported:
            raise ValidationError(f"currency {currency} is not supported. Supported: {', '.join(supported)}")

        return currency

    @staticmethod
    def validate_amount(amount: Any, field_name: str = "amount") -> Decimal:
        """
        Validate and sanitize monetary amount.

        Args:
            amount: Amount to validate (can be str, int, float, or Decimal)
            field_name: Name of field for error messages

        Returns:
            Decimal amount with 2 decimal places

        Raises:
            ValidationError: If amount is invalid
        """
        if amount is None:
            raise ValidationError(f"{field_name} is required")

        # Convert to Decimal for precise monetary calculations
        try:
            if isinstance(amount, str):
                amount = amount.strip()
            decimal_amount = Decimal(str(amount))
        except (InvalidOperation, ValueError, TypeError):
            raise ValidationError(f"{field_name} must be a valid number")

        # Round to 2 decimal places
        decimal_amount = decimal_amount.quantize(Decimal('0.01'))

        # Validate range
        if decimal_amount < BillingValidator.MIN_AMOUNT:
            raise ValidationError(f"{field_name} must be at least {BillingValidator.MIN_AMOUNT}")

        if decimal_amount > BillingValidator.MAX_AMOUNT:
            raise ValidationError(f"{field_name} cannot exceed {BillingValidator.MAX_AMOUNT}")

        return decimal_amount

    @staticmethod
    def validate_uuid(uuid_str: Optional[str], field_name: str = "id") -> UUID:
        """
        Validate UUID format.

        Args:
            uuid_str: UUID string to validate
            field_name: Name of field for error messages

        Returns:
            UUID object

        Raises:
            ValidationError: If UUID is invalid
        """
        if not uuid_str:
            raise ValidationError(f"{field_name} is required")

        try:
            if isinstance(uuid_str, UUID):
                return uuid_str
            return UUID(str(uuid_str).strip())
        except (ValueError, AttributeError):
            raise ValidationError(f"{field_name} is not a valid UUID")

    @staticmethod
    def validate_status(status: Optional[str]) -> str:
        """
        Validate subscription status.

        Only predefined statuses are allowed.
        """
        if not status:
            raise ValidationError("status is required")

        status = status.strip().lower()

        if not BillingValidator.STATUS_PATTERN.match(status):
            raise ValidationError(
                "status must be one of: active, cancelled, pending, expired, trial, pending_payment"
            )

        return status

    @staticmethod
    def sanitize_string(
        value: Optional[str],
        field_name: str = "field",
        max_length: Optional[int] = None,
        allow_html: bool = False
    ) -> str:
        """
        Sanitize string input.

        Args:
            value: String to sanitize
            field_name: Name of field for error messages
            max_length: Maximum allowed length
            allow_html: Whether to allow HTML tags (default: False)

        Returns:
            Sanitized string

        Raises:
            ValidationError: If string is invalid
        """
        if value is None:
            raise ValidationError(f"{field_name} is required")

        # Convert to string and strip whitespace
        value = str(value).strip()

        # Check length
        max_len = max_length or BillingValidator.MAX_STRING_LENGTH
        if len(value) > max_len:
            raise ValidationError(f"{field_name} is too long (max {max_len} characters)")

        # Remove HTML tags if not allowed (XSS prevention)
        if not allow_html:
            value = re.sub(r'<[^>]+>', '', value)

        # Remove null bytes (SQL injection prevention)
        value = value.replace('\x00', '')

        # Remove control characters except newlines and tabs
        value = ''.join(char for char in value if ord(char) >= 32 or char in '\n\t')

        return value

    @staticmethod
    def validate_storage_bytes(storage_bytes: Any) -> int:
        """
        Validate storage quota in bytes.

        Args:
            storage_bytes: Storage quota to validate

        Returns:
            Integer storage bytes

        Raises:
            ValidationError: If storage quota is invalid
        """
        if storage_bytes is None:
            raise ValidationError("storage_bytes is required")

        try:
            storage_bytes = int(storage_bytes)
        except (ValueError, TypeError):
            raise ValidationError("storage_bytes must be an integer")

        if storage_bytes < 0:
            raise ValidationError("storage_bytes cannot be negative")

        # Max 100 TB (100 * 1024^4 bytes)
        max_storage = 100 * (1024 ** 4)
        if storage_bytes > max_storage:
            raise ValidationError(f"storage_bytes cannot exceed {max_storage} (100 TB)")

        return storage_bytes

    @staticmethod
    def validate_payment_id(payment_id: Optional[str], gateway: str) -> str:
        """
        Validate payment ID format based on gateway.

        Args:
            payment_id: Payment ID to validate
            gateway: Payment gateway ('stripe' or 'razorpay')

        Returns:
            Sanitized payment ID

        Raises:
            ValidationError: If payment ID is invalid
        """
        if not payment_id:
            raise ValidationError("payment_id is required")

        payment_id = payment_id.strip()

        # Validate format based on gateway
        if gateway == 'stripe':
            # Stripe IDs: pi_xxx, ch_xxx, in_xxx, sub_xxx, etc.
            if not re.match(r'^(pi|ch|in|sub|cs|cus)_[A-Za-z0-9]{14,}$', payment_id):
                raise ValidationError("Invalid Stripe payment ID format")

        elif gateway == 'razorpay':
            # Razorpay IDs: pay_xxx, order_xxx, sub_xxx
            if not re.match(r'^(pay|order|sub)_[A-Za-z0-9]{14,}$', payment_id):
                raise ValidationError("Invalid Razorpay payment ID format")

        return payment_id

    @staticmethod
    def validate_webhook_signature(signature: Optional[str]) -> str:
        """
        Validate webhook signature format.

        Args:
            signature: Webhook signature to validate

        Returns:
            Sanitized signature

        Raises:
            ValidationError: If signature is invalid
        """
        if not signature:
            raise ValidationError("webhook signature is required")

        signature = signature.strip()

        # Basic validation (not empty, reasonable length)
        if len(signature) < 10:
            raise ValidationError("webhook signature is too short")

        if len(signature) > 500:
            raise ValidationError("webhook signature is too long")

        return signature

    @staticmethod
    def validate_ip_address(ip: Optional[str]) -> str:
        """
        Validate IP address format (IPv4 or IPv6).

        Args:
            ip: IP address to validate

        Returns:
            Sanitized IP address

        Raises:
            ValidationError: If IP is invalid
        """
        if not ip:
            raise ValidationError("IP address is required")

        ip = ip.strip()

        # IPv4 pattern
        ipv4_pattern = r'^(\d{1,3}\.){3}\d{1,3}$'
        # IPv6 pattern (simplified)
        ipv6_pattern = r'^([0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}$'

        if re.match(ipv4_pattern, ip):
            # Validate IPv4 octets
            octets = ip.split('.')
            for octet in octets:
                if int(octet) > 255:
                    raise ValidationError("Invalid IPv4 address")
            return ip

        elif re.match(ipv6_pattern, ip):
            return ip

        else:
            raise ValidationError("Invalid IP address format")

    @staticmethod
    def validate_refund_amount(
        refund_amount: Any,
        original_amount: Decimal,
        already_refunded: Decimal = Decimal('0.00')
    ) -> Decimal:
        """
        Validate refund amount.

        Args:
            refund_amount: Amount to refund
            original_amount: Original payment amount
            already_refunded: Amount already refunded

        Returns:
            Validated refund amount

        Raises:
            ValidationError: If refund amount is invalid
        """
        refund_amount = BillingValidator.validate_amount(refund_amount, "refund_amount")

        if refund_amount <= Decimal('0.00'):
            raise ValidationError("refund_amount must be greater than zero")

        total_refunded = already_refunded + refund_amount

        if total_refunded > original_amount:
            raise ValidationError(
                f"Total refund ({total_refunded}) cannot exceed original amount ({original_amount})"
            )

        return refund_amount

    @staticmethod
    def validate_date_range(start_date: datetime, end_date: datetime):
        """
        Validate date range.

        Args:
            start_date: Start date
            end_date: End date

        Raises:
            ValidationError: If date range is invalid
        """
        if start_date >= end_date:
            raise ValidationError("start_date must be before end_date")

        # Prevent excessively large date ranges (e.g., > 1 year)
        max_days = 366
        if (end_date - start_date).days > max_days:
            raise ValidationError(f"Date range cannot exceed {max_days} days")


class InputSanitizer:
    """
    Sanitize inputs to prevent injection attacks.

    Use in combination with BillingValidator.
    """

    @staticmethod
    def sanitize_for_sql(value: str) -> str:
        """
        Sanitize string for SQL (additional protection beyond parameterized queries).

        Args:
            value: String to sanitize

        Returns:
            Sanitized string
        """
        # Remove SQL comment markers
        value = value.replace('--', '')
        value = value.replace('/*', '')
        value = value.replace('*/', '')

        # Remove SQL keywords that could be dangerous
        dangerous_keywords = ['DROP', 'DELETE', 'TRUNCATE', 'ALTER', 'EXEC', 'EXECUTE']
        for keyword in dangerous_keywords:
            value = re.sub(rf'\b{keyword}\b', '', value, flags=re.IGNORECASE)

        return value

    @staticmethod
    def sanitize_for_html(value: str) -> str:
        """
        Sanitize string for HTML output (XSS prevention).

        Args:
            value: String to sanitize

        Returns:
            HTML-safe string
        """
        replacements = {
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#x27;',
            '&': '&amp;',
        }

        for char, replacement in replacements.items():
            value = value.replace(char, replacement)

        return value

    @staticmethod
    def sanitize_json_key(key: str) -> str:
        """
        Sanitize JSON key to prevent property injection.

        Args:
            key: JSON key to sanitize

        Returns:
            Sanitized key
        """
        # Only allow alphanumeric, underscore, and hyphen
        return re.sub(r'[^a-zA-Z0-9_-]', '', key)
