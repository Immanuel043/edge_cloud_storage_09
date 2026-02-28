"""
Invoice Service — generates invoice records and PDFs for successful payments.

Usage:
    from shared_billing.invoice_service import InvoiceService
    svc = InvoiceService(db, service_type='normal')
    invoice = await svc.create_invoice(user_id, subscription, plan, payment_id, ...)
    pdf_bytes = svc.generate_pdf(invoice, company_config)
"""
import io
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from typing import Optional, List
from uuid import UUID

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from .models import Invoice

logger = logging.getLogger(__name__)


@dataclass
class CompanyConfig:
    """Branding information rendered on each invoice PDF."""
    name: str = "Edge Cloud Storage"
    address: str = ""
    email: str = ""
    phone: str = ""
    gst: str = ""
    logo_url: str = ""


class InvoiceService:
    def __init__(self, db: AsyncSession, service_type: str = "normal"):
        self.db = db
        self.service_type = service_type

    async def _next_invoice_number(self) -> str:
        """Generate sequential invoice number: EC-YYYYMM-XXXX."""
        now = datetime.now(timezone.utc)
        prefix = f"EC-{now.strftime('%Y%m')}-"

        result = await self.db.execute(
            select(func.count())
            .select_from(Invoice)
            .where(Invoice.invoice_number.like(f"{prefix}%"))
        )
        count = (result.scalar() or 0) + 1
        return f"{prefix}{count:04d}"

    async def create_invoice(
        self,
        *,
        user_id: UUID,
        user_email: str,
        subscription_id: UUID,
        plan_code: str,
        plan_name: str,
        billing_cycle: str,
        amount: Decimal,
        currency: str = "INR",
        payment_gateway: str = "razorpay",
        razorpay_payment_id: Optional[str] = None,
        razorpay_order_id: Optional[str] = None,
        stripe_payment_intent_id: Optional[str] = None,
        paid_at: Optional[datetime] = None,
    ) -> Invoice:
        """Persist a new invoice after a successful payment."""
        invoice_number = await self._next_invoice_number()

        invoice = Invoice(
            invoice_number=invoice_number,
            user_id=user_id,
            service_type=self.service_type,
            subscription_id=subscription_id,
            user_email=user_email,
            plan_code=plan_code,
            plan_name=plan_name,
            billing_cycle=billing_cycle,
            amount=amount,
            currency=currency,
            payment_gateway=payment_gateway,
            razorpay_payment_id=razorpay_payment_id,
            razorpay_order_id=razorpay_order_id,
            stripe_payment_intent_id=stripe_payment_intent_id,
            status="paid",
            paid_at=paid_at or datetime.now(timezone.utc),
        )
        self.db.add(invoice)
        await self.db.flush()
        logger.info("Invoice %s created for user %s — %s %s",
                     invoice_number, user_id, currency, amount)
        return invoice

    async def get_user_invoices(
        self,
        user_id: UUID,
        limit: int = 50,
        offset: int = 0,
    ) -> List[Invoice]:
        result = await self.db.execute(
            select(Invoice)
            .where(Invoice.user_id == user_id,
                   Invoice.service_type == self.service_type)
            .order_by(Invoice.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        return list(result.scalars().all())

    async def get_invoice_by_id(
        self,
        invoice_id: UUID,
        user_id: UUID,
    ) -> Optional[Invoice]:
        result = await self.db.execute(
            select(Invoice)
            .where(Invoice.id == invoice_id,
                   Invoice.user_id == user_id)
        )
        return result.scalar_one_or_none()

    @staticmethod
    def generate_pdf(invoice: Invoice, company: CompanyConfig) -> bytes:
        """Return PDF bytes for the given invoice."""
        from fpdf import FPDF

        pdf = FPDF(orientation="P", unit="mm", format="A4")
        pdf.set_auto_page_break(auto=True, margin=20)
        pdf.add_page()

        _render_header(pdf, company)
        _render_invoice_meta(pdf, invoice)
        _render_line_items(pdf, invoice)
        _render_payment_reference(pdf, invoice)
        _render_footer(pdf, company)

        return pdf.output()


# ── PDF helper functions ──────────────────────────────────────────────────────

def _render_header(pdf, company: CompanyConfig):
    pdf.set_font("Helvetica", "B", 22)
    pdf.set_text_color(0, 51, 160)
    pdf.cell(0, 12, company.name or "Invoice", ln=True)
    pdf.set_font("Helvetica", "", 9)
    pdf.set_text_color(100, 100, 100)
    if company.address:
        pdf.cell(0, 5, company.address, ln=True)
    if company.email:
        pdf.cell(0, 5, f"Email: {company.email}", ln=True)
    if company.phone:
        pdf.cell(0, 5, f"Phone: {company.phone}", ln=True)
    if company.gst:
        pdf.cell(0, 5, f"GST: {company.gst}", ln=True)
    pdf.ln(6)
    pdf.set_draw_color(0, 51, 160)
    pdf.set_line_width(0.6)
    pdf.line(10, pdf.get_y(), 200, pdf.get_y())
    pdf.ln(8)


def _render_invoice_meta(pdf, invoice: Invoice):
    pdf.set_font("Helvetica", "B", 14)
    pdf.set_text_color(30, 30, 30)
    pdf.cell(0, 8, "INVOICE", ln=True)
    pdf.ln(2)

    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(60, 60, 60)

    y = pdf.get_y()
    # Left column
    pdf.set_xy(10, y)
    pdf.cell(40, 6, "Invoice No:", ln=False)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 6, invoice.invoice_number, ln=True)
    pdf.set_font("Helvetica", "", 10)

    pdf.cell(40, 6, "Date:", ln=False)
    paid = invoice.paid_at or invoice.created_at
    date_str = paid.strftime("%d %B %Y") if paid else "N/A"
    pdf.cell(0, 6, date_str, ln=True)

    pdf.cell(40, 6, "Status:", ln=False)
    pdf.set_text_color(22, 163, 74) if invoice.status == "paid" else pdf.set_text_color(220, 38, 38)
    pdf.set_font("Helvetica", "B", 10)
    pdf.cell(0, 6, invoice.status.upper(), ln=True)
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(60, 60, 60)

    if invoice.user_email:
        pdf.cell(40, 6, "Billed to:", ln=False)
        pdf.cell(0, 6, invoice.user_email, ln=True)

    pdf.ln(8)


def _render_line_items(pdf, invoice: Invoice):
    col_desc = 80
    col_cycle = 40
    col_qty = 20
    col_amount = 40

    # Table header
    pdf.set_fill_color(240, 243, 250)
    pdf.set_font("Helvetica", "B", 10)
    pdf.set_text_color(40, 40, 40)
    pdf.cell(col_desc, 8, "  Description", border=0, fill=True)
    pdf.cell(col_cycle, 8, "Billing Cycle", border=0, fill=True, align="C")
    pdf.cell(col_qty, 8, "Qty", border=0, fill=True, align="C")
    pdf.cell(col_amount, 8, "Amount", border=0, fill=True, align="R")
    pdf.ln()

    # Table row
    pdf.set_font("Helvetica", "", 10)
    pdf.set_text_color(60, 60, 60)

    cycle_label = {
        "monthly": "Monthly",
        "six_months": "6 Months",
        "yearly": "Yearly",
    }.get(invoice.billing_cycle or "", invoice.billing_cycle or "")

    currency_sym = "\u20b9" if invoice.currency == "INR" else "$"
    amount_str = f"{currency_sym}{invoice.amount:,.2f}"

    pdf.cell(col_desc, 8, f"  {invoice.plan_name}", border=0)
    pdf.cell(col_cycle, 8, cycle_label, border=0, align="C")
    pdf.cell(col_qty, 8, "1", border=0, align="C")
    pdf.cell(col_amount, 8, amount_str, border=0, align="R")
    pdf.ln()

    # Separator
    pdf.set_draw_color(200, 200, 200)
    pdf.set_line_width(0.3)
    pdf.line(10, pdf.get_y(), 200, pdf.get_y())
    pdf.ln(4)

    # Total
    pdf.set_font("Helvetica", "B", 12)
    pdf.set_text_color(30, 30, 30)
    pdf.cell(col_desc + col_cycle + col_qty, 8, "Total", border=0, align="R")
    pdf.cell(col_amount, 8, amount_str, border=0, align="R")
    pdf.ln(12)


def _render_payment_reference(pdf, invoice: Invoice):
    refs = []
    if invoice.razorpay_payment_id:
        refs.append(("Razorpay Payment ID", invoice.razorpay_payment_id))
    if invoice.razorpay_order_id:
        refs.append(("Razorpay Order ID", invoice.razorpay_order_id))
    if invoice.stripe_payment_intent_id:
        refs.append(("Stripe Payment Intent", invoice.stripe_payment_intent_id))

    if refs:
        pdf.set_font("Helvetica", "B", 10)
        pdf.set_text_color(60, 60, 60)
        pdf.cell(0, 6, "Payment Reference", ln=True)
        pdf.set_font("Helvetica", "", 9)
        pdf.set_text_color(100, 100, 100)
        for label, value in refs:
            pdf.cell(55, 5, f"{label}:", ln=False)
            pdf.cell(0, 5, value, ln=True)
        pdf.ln(6)


def _render_footer(pdf, company: CompanyConfig):
    pdf.set_y(-30)
    pdf.set_draw_color(200, 200, 200)
    pdf.set_line_width(0.3)
    pdf.line(10, pdf.get_y(), 200, pdf.get_y())
    pdf.ln(4)
    pdf.set_font("Helvetica", "I", 8)
    pdf.set_text_color(150, 150, 150)
    pdf.cell(0, 4, "This is a computer-generated invoice and does not require a signature.", align="C", ln=True)
    if company.name:
        pdf.cell(0, 4, f"\u00a9 {datetime.now().year} {company.name}. All rights reserved.", align="C", ln=True)
