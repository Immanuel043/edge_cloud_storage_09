# services/storage-service/app/services/email_service.py
"""
Email Service using Mailgun API

Sends verification emails and other transactional emails via Mailgun REST API.
"""
import httpx
import logging
from typing import Optional
from pathlib import Path
from jinja2 import Environment, FileSystemLoader, select_autoescape

from ..config import settings

logger = logging.getLogger(__name__)


class EmailService:
    """Service for sending emails via Mailgun API"""

    def __init__(self):
        self.api_key = settings.MAILGUN_API_KEY
        self.domain = settings.MAILGUN_DOMAIN
        self.api_url = f"{settings.MAILGUN_API_URL}/{self.domain}/messages"
        self.from_email = settings.MAILGUN_FROM_EMAIL
        self.from_name = settings.MAILGUN_FROM_NAME
        self.enabled = settings.MAILGUN_ENABLED

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
            logger.warning("Mailgun is disabled, skipping email send")
            return False

        if not self.api_key or not self.domain:
            logger.error("Mailgun API key or domain not configured")
            return False

        try:
            # Load and render email template
            template = self.jinja_env.get_template("verification_email.html")
            html_content = template.render(
                code=code,
                expiry_minutes=settings.VERIFICATION_CODE_EXPIRY_MINUTES,
                app_name=settings.MAILGUN_FROM_NAME
            )

            # Prepare email data for Mailgun API
            data = {
                "from": f"{self.from_name} <{self.from_email}>",
                "to": [email],
                "subject": f"Verify your email - {code}",
                "html": html_content,
                "text": f"Your verification code is: {code}\n\nThis code will expire in {settings.VERIFICATION_CODE_EXPIRY_MINUTES} minutes.\n\nIf you didn't request this code, please ignore this email."
            }

            # Send email via Mailgun API
            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    self.api_url,
                    auth=("api", self.api_key),
                    data=data
                )

                if response.status_code == 200:
                    logger.info(f"Verification email sent successfully to {email}")
                    return True
                else:
                    logger.error(
                        f"Failed to send verification email: {response.status_code} - {response.text}",
                        extra={"email": email, "status_code": response.status_code}
                    )
                    return False

        except httpx.TimeoutException:
            logger.error(f"Timeout sending verification email to {email}")
            return False
        except Exception as e:
            logger.error(
                f"Error sending verification email to {email}: {str(e)}",
                exc_info=True
            )
            return False

    async def send_password_reset_code(self, email: str, code: str) -> bool:
        """Send password reset code email via Mailgun API."""
        if not self.enabled:
            logger.warning("Mailgun is disabled, skipping password reset email")
            return False

        if not self.api_key or not self.domain:
            logger.error("Mailgun API key or domain not configured")
            return False

        try:
            template = self.jinja_env.get_template("password_reset_email.html")
            html_content = template.render(
                code=code,
                expiry_minutes=settings.VERIFICATION_CODE_EXPIRY_MINUTES,
                app_name=settings.MAILGUN_FROM_NAME
            )

            data = {
                "from": f"{self.from_name} <{self.from_email}>",
                "to": [email],
                "subject": f"Reset your password - {code}",
                "html": html_content,
                "text": f"Your password reset code is: {code}\n\nThis code will expire in {settings.VERIFICATION_CODE_EXPIRY_MINUTES} minutes.\n\nIf you didn't request this, please ignore this email."
            }

            async with httpx.AsyncClient(timeout=10.0) as client:
                response = await client.post(
                    self.api_url,
                    auth=("api", self.api_key),
                    data=data
                )
                if response.status_code == 200:
                    logger.info(f"Password reset email sent successfully to {email}")
                    return True
                else:
                    logger.error(f"Failed to send password reset email: {response.status_code}")
                    return False

        except Exception as e:
            logger.error(f"Error sending password reset email to {email}: {str(e)}", exc_info=True)
            return False

    async def send_zk_recovery_instructions(self, email: str) -> bool:
        """Send ZK recovery phrase instructions email."""
        if not self.enabled:
            return False

        try:
            template = self.jinja_env.get_template("password_reset_zk_email.html")
            html_content = template.render(app_name=settings.MAILGUN_FROM_NAME)
        except Exception:
            html_content = (
                "<p>Your account uses Zero-Knowledge Encryption. "
                "To reset your password, use your 24-word recovery phrase on the login page.</p>"
            )

        return await self.send_email(
            to_email=email,
            subject=f"Password reset instructions - {self.from_name}",
            html_content=html_content,
            text_content="Your account uses Zero-Knowledge Encryption. To reset your password, use your 24-word recovery phrase on the login page.",
        )

    async def send_oauth_login_instructions(self, email: str) -> bool:
        """Send OAuth social login reminder email."""
        if not self.enabled:
            return False

        try:
            template = self.jinja_env.get_template("password_reset_oauth_email.html")
            html_content = template.render(app_name=settings.MAILGUN_FROM_NAME)
        except Exception:
            html_content = (
                "<p>Your account uses social login (Google or Microsoft). "
                "Please use that method to sign in on the login page.</p>"
            )

        return await self.send_email(
            to_email=email,
            subject=f"Password reset instructions - {self.from_name}",
            html_content=html_content,
            text_content="Your account uses social login (Google or Microsoft). Please use that method to sign in on the login page.",
        )

    async def send_email(
        self,
        to_email: str,
        subject: str,
        html_content: str,
        text_content: Optional[str] = None,
        attachments: Optional[list] = None,
    ) -> bool:
        """
        Generic method to send email via Mailgun API.

        Args:
            to_email: Recipient email address
            subject: Email subject
            html_content: HTML email body
            text_content: Plain text email body (optional)
            attachments: List of (filename, content_bytes, mime_type) tuples

        Returns:
            True if email sent successfully, False otherwise
        """
        if not self.enabled:
            logger.warning("Mailgun is disabled, skipping email send")
            return False

        if not self.api_key or not self.domain:
            logger.error("Mailgun API key or domain not configured")
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

            files_payload = None
            if attachments:
                files_payload = [
                    ("attachment", (fname, fbytes, fmime))
                    for fname, fbytes, fmime in attachments
                ]

            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    self.api_url,
                    auth=("api", self.api_key),
                    data=data,
                    files=files_payload,
                )

                if response.status_code == 200:
                    logger.info(f"Email sent successfully to {to_email}")
                    return True
                else:
                    logger.error(
                        f"Failed to send email: {response.status_code} - {response.text}",
                        extra={"email": to_email, "status_code": response.status_code}
                    )
                    return False

        except Exception as e:
            logger.error(
                f"Error sending email to {to_email}: {str(e)}",
                exc_info=True
            )
            return False

    async def send_invoice_email(
        self,
        to_email: str,
        invoice_number: str,
        plan_name: str,
        amount: str,
        currency: str,
        pdf_bytes: bytes,
    ) -> bool:
        """Send an invoice email with the PDF attached."""
        try:
            template = self.jinja_env.get_template("invoice_email.html")
            html_content = template.render(
                invoice_number=invoice_number,
                plan_name=plan_name,
                amount=amount,
                currency=currency,
                app_name=self.from_name,
            )
        except Exception:
            html_content = (
                f"<p>Your invoice <b>{invoice_number}</b> for "
                f"<b>{plan_name}</b> ({currency} {amount}) is attached.</p>"
            )

        return await self.send_email(
            to_email=to_email,
            subject=f"Invoice {invoice_number} - {self.from_name}",
            html_content=html_content,
            text_content=f"Your invoice {invoice_number} for {plan_name} ({currency} {amount}) is attached.",
            attachments=[
                (f"{invoice_number}.pdf", pdf_bytes, "application/pdf"),
            ],
        )


    async def send_share_notification(
        self,
        to_email: str,
        owner_email: str,
        item_name: str,
        item_type: str,
        permission: str,
        message: Optional[str] = None,
        share_url: Optional[str] = None,
    ) -> bool:
        """
        Send notification when someone shares a file/folder with a user.

        Args:
            to_email: Recipient email
            owner_email: Email of the person sharing
            item_name: Name of the shared file/folder
            item_type: 'file' or 'folder'
            permission: Permission level (view, download, edit)
            message: Optional personal message from the sharer
            share_url: Optional direct link to the shared content

        Returns:
            True if sent successfully
        """
        try:
            template = self.jinja_env.get_template("share_notification_email.html")
            html_content = template.render(
                owner_email=owner_email,
                item_name=item_name,
                item_type=item_type,
                permission=permission,
                message=message,
                share_url=share_url,
                app_name=self.from_name,
            )
        except Exception:
            # Fallback if template is missing
            html_content = (
                f"<p><b>{owner_email}</b> shared a {item_type} with you: "
                f"<b>{item_name}</b> ({permission} access).</p>"
            )
            if message:
                html_content += f'<p>Message: "{message}"</p>'
            if share_url:
                html_content += f'<p><a href="{share_url}">Open shared {item_type}</a></p>'

        text_content = (
            f"{owner_email} shared a {item_type} with you: {item_name} ({permission} access)."
        )
        if message:
            text_content += f'\nMessage: "{message}"'
        if share_url:
            text_content += f"\n\nOpen shared {item_type}: {share_url}"

        return await self.send_email(
            to_email=to_email,
            subject=f"{owner_email} shared a {item_type} with you — {self.from_name}",
            html_content=html_content,
            text_content=text_content,
        )


# Global service instance
email_service = EmailService()

