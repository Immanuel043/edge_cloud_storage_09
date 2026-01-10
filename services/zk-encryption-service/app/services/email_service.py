# services/zk-encryption-service/app/services/email_service.py
"""
Email Service using Mailgun API for ZK Encryption Service

Sends verification emails and other transactional emails via Mailgun REST API.
Adapted from storage service with ZK-specific branding.
"""
import httpx
import structlog
from typing import Optional
from pathlib import Path
from jinja2 import Environment, FileSystemLoader, select_autoescape
import os

logger = structlog.get_logger()


class EmailService:
    """Service for sending emails via Mailgun API"""

    def __init__(self):
        self.api_key = os.getenv("MAILGUN_API_KEY", "")
        self.domain = os.getenv("MAILGUN_DOMAIN", "")
        self.api_url = f"https://api.mailgun.net/v3/{self.domain}/messages"
        self.from_email = os.getenv("MAILGUN_FROM_EMAIL", "noreply@yourdomain.com")
        self.from_name = os.getenv("MAILGUN_FROM_NAME", "Edge Cloud ZK Storage")
        self.enabled = os.getenv("MAILGUN_ENABLED", "true").lower() == "true"
        self.expiry_minutes = 30  # Verification code expiry

        # Setup Jinja2 for email templates
        template_dir = Path(__file__).parent.parent / "templates"
        template_dir.mkdir(exist_ok=True)
        self.jinja_env = Environment(
            loader=FileSystemLoader(str(template_dir)),
            autoescape=select_autoescape(['html', 'xml'])
        )

    async def send_verification_code(self, email: str, code: str) -> bool:
        """
        Send verification code email via Mailgun API.

        Args:
            email: Recipient email address
            code: 6-digit verification code

        Returns:
            True if email sent successfully, False otherwise
        """
        if not self.enabled:
            logger.warning("mailgun_disabled", message="Mailgun is disabled, skipping email send")
            return False

        if not self.api_key or not self.domain:
            logger.error("mailgun_not_configured", message="Mailgun API key or domain not configured")
            return False

        try:
            # Try to load template, fallback to inline HTML if not found
            try:
                template = self.jinja_env.get_template("verification_email.html")
                html_content = template.render(
                    code=code,
                    expiry_minutes=self.expiry_minutes,
                    app_name=self.from_name
                )
            except Exception:
                # Fallback inline HTML template
                html_content = f"""
                <!DOCTYPE html>
                <html>
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                </head>
                <body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
                    <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 30px; text-align: center; border-radius: 10px 10px 0 0;">
                        <h1 style="color: white; margin: 0; font-size: 28px;">🔒 {self.from_name}</h1>
                    </div>
                    <div style="background: #f9f9f9; padding: 30px; border-radius: 0 0 10px 10px; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                        <h2 style="color: #667eea; margin-top: 0;">Verify Your Email Address</h2>
                        <p style="font-size: 16px; margin-bottom: 20px;">Thank you for registering with Zero-Knowledge Encryption! Please use the verification code below to complete your registration:</p>
                        <div style="background: white; border: 2px solid #667eea; border-radius: 8px; padding: 20px; text-align: center; margin: 30px 0;">
                            <p style="margin: 0 0 10px 0; color: #666; font-size: 14px;">Your Verification Code:</p>
                            <h1 style="margin: 0; color: #667eea; font-size: 48px; letter-spacing: 8px; font-family: 'Courier New', monospace;">{code}</h1>
                        </div>
                        <p style="color: #666; font-size: 14px; margin-top: 20px;">This code will expire in <strong>{self.expiry_minutes} minutes</strong>.</p>
                        <p style="color: #666; font-size: 14px;">If you didn't request this code, please ignore this email.</p>
                        <hr style="border: none; border-top: 1px solid #e0e0e0; margin: 30px 0;">
                        <p style="color: #999; font-size: 12px; text-align: center;">
                            © 2026 {self.from_name}. All rights reserved.<br>
                            Your privacy is protected with zero-knowledge encryption.
                        </p>
                    </div>
                </body>
                </html>
                """

            # Prepare email data for Mailgun API
            data = {
                "from": f"{self.from_name} <{self.from_email}>",
                "to": [email],
                "subject": f"🔐 Verify your email - {code}",
                "html": html_content,
                "text": f"Your verification code is: {code}\n\nThis code will expire in {self.expiry_minutes} minutes.\n\nIf you didn't request this code, please ignore this email.\n\n{self.from_name} - Zero-Knowledge Encryption"
            }

            # Send email via Mailgun API
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    self.api_url,
                    auth=("api", self.api_key),
                    data=data
                )

                if response.status_code == 200:
                    logger.info("zk_verification_email_sent", email=email, code_length=len(code))
                    return True
                else:
                    logger.error(
                        "zk_verification_email_failed",
                        email=email,
                        status_code=response.status_code,
                        response=response.text
                    )
                    return False

        except httpx.TimeoutException:
            logger.error("zk_email_timeout", email=email)
            return False
        except Exception as e:
            logger.error("zk_email_send_error", email=email, error=str(e))
            return False

    async def send_email(
        self,
        to_email: str,
        subject: str,
        html_content: str,
        text_content: Optional[str] = None
    ) -> bool:
        """
        Generic method to send email via Mailgun API.

        Args:
            to_email: Recipient email address
            subject: Email subject
            html_content: HTML email body
            text_content: Plain text email body (optional)

        Returns:
            True if email sent successfully, False otherwise
        """
        if not self.enabled:
            logger.warning("mailgun_disabled", message="Mailgun is disabled")
            return False

        if not self.api_key or not self.domain:
            logger.error("mailgun_not_configured")
            return False

        try:
            data = {
                "from": f"{self.from_name} <{self.from_email}>",
                "to": [to_email],
                "subject": subject,
                "html": html_content,
            }

            if text_content:
                data["text"] = text_content

            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    self.api_url,
                    auth=("api", self.api_key),
                    data=data
                )

                if response.status_code == 200:
                    logger.info("zk_email_sent", email=to_email, subject=subject)
                    return True
                else:
                    logger.error(
                        "zk_email_failed",
                        email=to_email,
                        status_code=response.status_code,
                        response=response.text
                    )
                    return False

        except Exception as e:
            logger.error("zk_email_send_error", email=to_email, error=str(e))
            return False


# Global service instance
email_service = EmailService()
