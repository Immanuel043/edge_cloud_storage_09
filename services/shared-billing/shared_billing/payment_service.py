"""
Unified Payment Service

Abstracts both Razorpay and Stripe payment gateways for consistent API.
"""
import logging
from typing import Dict, Any, Optional, Literal
from decimal import Decimal

from .razorpay_service import RazorpayService
from .stripe_service import StripeService

logger = logging.getLogger(__name__)


class PaymentService:
    """Unified payment service supporting Razorpay and Stripe"""
    
    def __init__(
        self,
        gateway: Literal['razorpay', 'stripe'],
        razorpay_key_id: str = "",
        razorpay_key_secret: str = "",
        razorpay_webhook_secret: str = "",
        stripe_secret_key: str = "",
        stripe_webhook_secret: str = "",
        stripe_publishable_key: str = ""
    ):
        """
        Initialize payment service with selected gateway.
        
        Args:
            gateway: Payment gateway to use ('razorpay' or 'stripe')
            razorpay_key_id: Razorpay key ID
            razorpay_key_secret: Razorpay key secret
            razorpay_webhook_secret: Razorpay webhook secret
            stripe_secret_key: Stripe secret key
            stripe_webhook_secret: Stripe webhook secret
            stripe_publishable_key: Stripe publishable key
        """
        self.gateway = gateway
        
        if gateway == 'razorpay':
            if not razorpay_key_id or not razorpay_key_secret:
                raise ValueError("Razorpay credentials are required")
            self.client = RazorpayService(
                key_id=razorpay_key_id,
                key_secret=razorpay_key_secret,
                webhook_secret=razorpay_webhook_secret
            )
        elif gateway == 'stripe':
            if not stripe_secret_key:
                raise ValueError("Stripe secret key is required")
            self.client = StripeService(
                secret_key=stripe_secret_key,
                webhook_secret=stripe_webhook_secret,
                publishable_key=stripe_publishable_key
            )
        else:
            raise ValueError(f"Unsupported payment gateway: {gateway}")
        
        logger.info(f"PaymentService initialized with gateway: {gateway}")
    
    async def create_payment(
        self,
        amount: Decimal,
        currency: str,
        plan_code: str,
        billing_cycle: str,
        user_id: str,
        user_email: str,
        success_url: str,
        cancel_url: str,
        plan_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """
        Create payment using selected gateway.
        
        Args:
            amount: Payment amount
            currency: Currency code
            plan_code: Plan code
            billing_cycle: Billing cycle (monthly, six_months, yearly)
            user_id: User ID
            user_email: User email
            success_url: Success redirect URL
            cancel_url: Cancel redirect URL
            plan_id: Gateway-specific plan ID (Razorpay plan_id or Stripe price_id)
            
        Returns:
            Payment details including payment URL
        """
        metadata = {
            'user_id': str(user_id),
            'plan_code': plan_code,
            'billing_cycle': billing_cycle,
            'service_type': 'zk' if 'zk' in plan_code else 'normal'
        }
        
        if self.gateway == 'razorpay':
            if billing_cycle == 'yearly' and plan_id:
                # Use subscription for yearly recurring
                subscription = self.client.create_subscription(
                    plan_id=plan_id,
                    notes=metadata
                )
                return {
                    'payment_url': subscription.get('short_url') or None,
                    'subscription_id': subscription['id'],
                    'order_id': None,
                    'gateway': 'razorpay',
                    'razorpay_key_id': self.client.client.auth[0] if hasattr(self.client, 'client') else None
                }
            else:
                # Razorpay receipt max 40 chars — use short user ID suffix
                short_uid = str(user_id).replace('-', '')[-8:]
                receipt = f"{plan_code}_{short_uid}_{billing_cycle}"[:40]
                order = self.client.create_order(
                    amount=amount,
                    currency=currency,
                    receipt=receipt,
                    notes=metadata
                )
                return {
                    'payment_url': None,  # Frontend will use Razorpay checkout
                    'order_id': order['order_id'],
                    'subscription_id': None,
                    'gateway': 'razorpay',
                    'razorpay_key_id': self.client.client.auth[0] if hasattr(self.client, 'client') else None,
                    'amount': order['amount'],
                    'currency': order['currency']
                }
        
        elif self.gateway == 'stripe':
            if not plan_id:
                raise ValueError("Stripe price_id is required")
            
            # Create or get customer
            customer = self.client.create_customer(
                email=user_email,
                metadata=metadata
            )
            
            # Create checkout session
            session = self.client.create_checkout_session(
                price_id=plan_id,
                customer_id=customer['id'],
                success_url=success_url,
                cancel_url=cancel_url,
                metadata=metadata
            )
            
            return {
                'payment_url': session['payment_url'],
                'session_id': session['session_id'],
                'customer_id': session['customer_id'],
                'subscription_id': session.get('subscription_id'),
                'gateway': 'stripe'
            }
        
        else:
            raise ValueError(f"Unsupported gateway: {self.gateway}")
    
    async def verify_payment(
        self,
        payment_id: str,
        order_id: Optional[str] = None,
        signature: Optional[str] = None
    ) -> bool:
        """
        Verify payment signature.
        
        Args:
            payment_id: Payment ID
            order_id: Order ID (for Razorpay)
            signature: Payment signature (for Razorpay)
            
        Returns:
            True if payment is verified
        """
        if self.gateway == 'razorpay':
            if not order_id or not signature:
                raise ValueError("Razorpay verification requires order_id and signature")
            return self.client.verify_payment_signature(payment_id, order_id, signature)
        
        elif self.gateway == 'stripe':
            # Stripe verification is done via webhooks
            # This method can check payment status
            payment = self.client.get_payment_status(payment_id)
            return payment.get('status') == 'succeeded'
        
        else:
            raise ValueError(f"Unsupported gateway: {self.gateway}")
    
    def verify_webhook(
        self,
        payload: bytes,
        signature: str
    ) -> Dict[str, Any]:
        """
        Verify webhook signature and parse event.
        
        Args:
            payload: Webhook payload
            signature: Webhook signature
            
        Returns:
            Parsed event/entity
        """
        if self.gateway == 'razorpay':
            # Razorpay expects string payload
            if isinstance(payload, bytes):
                payload = payload.decode('utf-8')
            is_valid = self.client.verify_webhook_signature(payload, signature)
            if not is_valid:
                raise ValueError("Invalid Razorpay webhook signature")
            # Return payload as dict (frontend will parse JSON)
            import json
            return json.loads(payload) if isinstance(payload, str) else payload
        
        elif self.gateway == 'stripe':
            # Stripe expects bytes payload
            if isinstance(payload, str):
                payload = payload.encode('utf-8')
            return self.client.verify_webhook_signature(payload, signature)
        
        else:
            raise ValueError(f"Unsupported gateway: {self.gateway}")
    
    def get_subscription(self, subscription_id: str) -> Dict[str, Any]:
        """Get subscription details from gateway."""
        return self.client.get_subscription(subscription_id)
    
    def cancel_subscription(self, subscription_id: str) -> Dict[str, Any]:
        """Cancel subscription in gateway."""
        return self.client.cancel_subscription(subscription_id)
