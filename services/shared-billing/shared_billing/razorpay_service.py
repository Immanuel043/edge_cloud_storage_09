"""
Razorpay Payment Service

Handles Razorpay payment operations for subscription management.
"""
import logging
import hmac
import hashlib
from typing import Dict, Any, Optional
from decimal import Decimal

try:
    import razorpay
except ImportError:
    razorpay = None

logger = logging.getLogger(__name__)


class RazorpayService:
    """Service for handling Razorpay payment operations"""
    
    def __init__(self, key_id: str, key_secret: str, webhook_secret: str):
        """
        Initialize Razorpay service.
        
        Args:
            key_id: Razorpay key ID
            key_secret: Razorpay key secret
            webhook_secret: Razorpay webhook secret for signature verification
        """
        if razorpay is None:
            raise ImportError("razorpay package not installed. Install with: pip install razorpay>=1.4.0")
        
        if not key_id or not key_secret:
            raise ValueError("Razorpay key_id and key_secret are required")
        
        self.client = razorpay.Client(auth=(key_id, key_secret))
        self.webhook_secret = webhook_secret
        logger.info("Razorpay service initialized")
    
    def create_order(
        self,
        amount: Decimal,
        currency: str,
        receipt: str,
        notes: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Create a Razorpay order for one-time payment.
        
        Args:
            amount: Amount in smallest currency unit (paise for INR)
            currency: Currency code (e.g., 'INR')
            receipt: Receipt identifier
            notes: Optional metadata
            
        Returns:
            Order details including order_id and payment URL
        """
        # Convert amount to paise (smallest currency unit for INR)
        amount_paise = int(float(amount) * 100) if currency == 'INR' else int(float(amount) * 100)
        
        order_data = {
            'amount': amount_paise,
            'currency': currency,
            'receipt': receipt,
            'notes': notes or {}
        }
        
        try:
            order = self.client.order.create(data=order_data)
            logger.info(f"Created Razorpay order: {order['id']}")
            
            return {
                'order_id': order['id'],
                'amount': order['amount'],
                'currency': order['currency'],
                'status': order['status'],
                'payment_url': None  # Razorpay doesn't provide direct payment URL, use checkout
            }
        except Exception as e:
            logger.error(f"Failed to create Razorpay order: {e}")
            raise
    
    def create_subscription(
        self,
        plan_id: str,
        customer_notify: int = 1,
        notes: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Create a Razorpay subscription for recurring payments.
        
        Args:
            plan_id: Razorpay plan ID
            customer_notify: Whether to notify customer (1 = yes, 0 = no)
            notes: Optional metadata
            
        Returns:
            Subscription details
        """
        subscription_data = {
            'plan_id': plan_id,
            'customer_notify': customer_notify,
            'notes': notes or {}
        }
        
        try:
            subscription = self.client.subscription.create(data=subscription_data)
            logger.info(f"Created Razorpay subscription: {subscription['id']}")
            return subscription
        except Exception as e:
            logger.error(f"Failed to create Razorpay subscription: {e}")
            raise
    
    def verify_payment_signature(
        self,
        payment_id: str,
        order_id: str,
        signature: str
    ) -> bool:
        """
        Verify Razorpay payment signature.
        
        Args:
            payment_id: Payment ID from Razorpay
            order_id: Order ID
            signature: Signature to verify
            
        Returns:
            True if signature is valid, False otherwise
        """
        try:
            message = f"{order_id}|{payment_id}"
            generated_signature = hmac.new(
                self.client.auth[1].encode(),  # key_secret
                message.encode(),
                hashlib.sha256
            ).hexdigest()
            
            is_valid = hmac.compare_digest(generated_signature, signature)
            if not is_valid:
                logger.warning(f"Invalid Razorpay payment signature for payment {payment_id}")
            return is_valid
        except Exception as e:
            logger.error(f"Error verifying Razorpay signature: {e}")
            return False
    
    def verify_webhook_signature(
        self,
        payload: str,
        signature: str
    ) -> bool:
        """
        Verify Razorpay webhook signature.

        Args:
            payload: Webhook payload (string)
            signature: Webhook signature from headers

        Returns:
            True if signature is valid, False otherwise

        Raises:
            ValueError: If webhook secret is not configured
        """
        if not self.webhook_secret:
            logger.error("CRITICAL: Webhook secret not configured - cannot verify signature")
            raise ValueError(
                "Webhook secret not configured. Set RAZORPAY_WEBHOOK_SECRET environment variable."
            )
        
        try:
            generated_signature = hmac.new(
                self.webhook_secret.encode(),
                payload.encode(),
                hashlib.sha256
            ).hexdigest()
            
            is_valid = hmac.compare_digest(generated_signature, signature)
            if not is_valid:
                logger.warning("Invalid Razorpay webhook signature")
            return is_valid
        except Exception as e:
            logger.error(f"Error verifying Razorpay webhook signature: {e}")
            return False
    
    def get_payment_status(self, payment_id: str) -> Dict[str, Any]:
        """
        Get payment status from Razorpay.
        
        Args:
            payment_id: Payment ID
            
        Returns:
            Payment details
        """
        try:
            payment = self.client.payment.fetch(payment_id)
            return payment
        except Exception as e:
            logger.error(f"Failed to fetch Razorpay payment {payment_id}: {e}")
            raise
    
    def cancel_subscription(self, subscription_id: str) -> Dict[str, Any]:
        """
        Cancel a Razorpay subscription.
        
        Args:
            subscription_id: Subscription ID
            
        Returns:
            Cancelled subscription details
        """
        try:
            subscription = self.client.subscription.cancel(subscription_id)
            logger.info(f"Cancelled Razorpay subscription: {subscription_id}")
            return subscription
        except Exception as e:
            logger.error(f"Failed to cancel Razorpay subscription {subscription_id}: {e}")
            raise
    
    def get_subscription(self, subscription_id: str) -> Dict[str, Any]:
        """
        Get subscription details from Razorpay.
        
        Args:
            subscription_id: Subscription ID
            
        Returns:
            Subscription details
        """
        try:
            subscription = self.client.subscription.fetch(subscription_id)
            return subscription
        except Exception as e:
            logger.error(f"Failed to fetch Razorpay subscription {subscription_id}: {e}")
            raise
