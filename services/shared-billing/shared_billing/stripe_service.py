"""
Stripe Payment Service

Handles Stripe payment operations for subscription management.
"""
import logging
from typing import Dict, Any, Optional
from decimal import Decimal

try:
    import stripe
except ImportError:
    stripe = None

logger = logging.getLogger(__name__)


class StripeService:
    """Service for handling Stripe payment operations"""
    
    def __init__(self, secret_key: str, webhook_secret: str, publishable_key: str = ""):
        """
        Initialize Stripe service.
        
        Args:
            secret_key: Stripe secret key
            webhook_secret: Stripe webhook secret for signature verification
            publishable_key: Stripe publishable key (for frontend)
        """
        if stripe is None:
            raise ImportError("stripe package not installed. Install with: pip install stripe>=7.0.0")
        
        if not secret_key:
            raise ValueError("Stripe secret_key is required")
        
        stripe.api_key = secret_key
        self.webhook_secret = webhook_secret
        self.publishable_key = publishable_key
        logger.info("Stripe service initialized")
    
    def create_checkout_session(
        self,
        price_id: str,
        customer_id: Optional[str] = None,
        success_url: str = "",
        cancel_url: str = "",
        metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Create a Stripe Checkout session.
        
        Args:
            price_id: Stripe price ID
            customer_id: Optional existing customer ID
            success_url: URL to redirect after successful payment
            cancel_url: URL to redirect after cancelled payment
            metadata: Optional metadata
            
        Returns:
            Checkout session details including URL
        """
        session_data = {
            'payment_method_types': ['card'],
            'line_items': [{
                'price': price_id,
                'quantity': 1,
            }],
            'mode': 'subscription',
            'success_url': success_url,
            'cancel_url': cancel_url,
            'metadata': metadata or {}
        }
        
        if customer_id:
            session_data['customer'] = customer_id
        
        try:
            session = stripe.checkout.Session.create(**session_data)
            logger.info(f"Created Stripe checkout session: {session['id']}")
            
            return {
                'session_id': session['id'],
                'payment_url': session['url'],
                'customer_id': session.get('customer'),
                'subscription_id': session.get('subscription')
            }
        except Exception as e:
            logger.error(f"Failed to create Stripe checkout session: {e}")
            raise
    
    def create_customer(
        self,
        email: str,
        metadata: Optional[Dict[str, Any]] = None
    ) -> Dict[str, Any]:
        """
        Create a Stripe customer.
        
        Args:
            email: Customer email
            metadata: Optional metadata
            
        Returns:
            Customer details
        """
        try:
            customer = stripe.Customer.create(
                email=email,
                metadata=metadata or {}
            )
            logger.info(f"Created Stripe customer: {customer['id']}")
            return customer
        except Exception as e:
            logger.error(f"Failed to create Stripe customer: {e}")
            raise
    
    def verify_webhook_signature(
        self,
        payload: bytes,
        signature: str
    ) -> Dict[str, Any]:
        """
        Verify Stripe webhook signature and parse event.
        
        Args:
            payload: Webhook payload (bytes)
            signature: Webhook signature from headers
            
        Returns:
            Parsed event object
            
        Raises:
            ValueError: If signature is invalid
        """
        if not self.webhook_secret:
            logger.error("CRITICAL: Webhook secret not configured - cannot verify signature")
            raise ValueError(
                "Webhook secret not configured. Set STRIPE_WEBHOOK_SECRET environment variable."
            )
        
        try:
            event = stripe.Webhook.construct_event(
                payload,
                signature,
                self.webhook_secret
            )
            return event
        except ValueError as e:
            logger.error(f"Invalid Stripe webhook signature: {e}")
            raise
        except Exception as e:
            logger.error(f"Error verifying Stripe webhook: {e}")
            raise
    
    def get_payment_status(self, payment_intent_id: str) -> Dict[str, Any]:
        """
        Get payment intent status from Stripe.
        
        Args:
            payment_intent_id: Payment intent ID
            
        Returns:
            Payment intent details
        """
        try:
            payment_intent = stripe.PaymentIntent.retrieve(payment_intent_id)
            return payment_intent
        except Exception as e:
            logger.error(f"Failed to fetch Stripe payment intent {payment_intent_id}: {e}")
            raise
    
    def cancel_subscription(self, subscription_id: str) -> Dict[str, Any]:
        """
        Cancel a Stripe subscription.
        
        Args:
            subscription_id: Subscription ID
            
        Returns:
            Cancelled subscription details
        """
        try:
            subscription = stripe.Subscription.modify(
                subscription_id,
                cancel_at_period_end=True
            )
            logger.info(f"Cancelled Stripe subscription: {subscription_id}")
            return subscription
        except Exception as e:
            logger.error(f"Failed to cancel Stripe subscription {subscription_id}: {e}")
            raise
    
    def get_subscription(self, subscription_id: str) -> Dict[str, Any]:
        """
        Get subscription details from Stripe.
        
        Args:
            subscription_id: Subscription ID
            
        Returns:
            Subscription details
        """
        try:
            subscription = stripe.Subscription.retrieve(subscription_id)
            return subscription
        except Exception as e:
            logger.error(f"Failed to fetch Stripe subscription {subscription_id}: {e}")
            raise
