"""Create invoices table

Stores invoice records generated after each successful payment.
PDFs are generated on-demand from the stored data.

Revision ID: 20260228_0001
Revises: 20260226_0001
Create Date: 2026-02-28
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "20260228_0001"
down_revision = "20260226_0001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "invoices",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        sa.Column("invoice_number", sa.String(30), unique=True, nullable=False),
        # Reference
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("service_type", sa.String(20), nullable=False),
        sa.Column("subscription_id", postgresql.UUID(as_uuid=True)),
        sa.Column("user_email", sa.String(255)),
        # Plan details at time of invoice
        sa.Column("plan_code", sa.String(50), nullable=False),
        sa.Column("plan_name", sa.String(100), nullable=False),
        sa.Column("billing_cycle", sa.String(20)),
        # Amount
        sa.Column("amount", sa.Numeric(10, 2), nullable=False),
        sa.Column("currency", sa.String(3), server_default="INR", nullable=False),
        # Payment gateway
        sa.Column("payment_gateway", sa.String(20)),
        sa.Column("razorpay_payment_id", sa.String(255)),
        sa.Column("razorpay_order_id", sa.String(255)),
        sa.Column("stripe_payment_intent_id", sa.String(255)),
        # Status
        sa.Column("status", sa.String(20), nullable=False, server_default="paid"),
        sa.Column("paid_at", sa.DateTime(timezone=True)),
        # Metadata
        sa.Column("extra_metadata", postgresql.JSONB(), server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        # Foreign Keys
        sa.ForeignKeyConstraint(["subscription_id"], ["user_subscriptions.id"]),
        comment="Invoices generated for successful payments",
    )

    op.create_index("idx_invoices_number", "invoices", ["invoice_number"], unique=True)
    op.create_index("idx_invoices_user", "invoices", ["user_id", "service_type"])
    op.create_index("idx_invoices_subscription", "invoices", ["subscription_id"])
    op.create_index("idx_invoices_paid_at", "invoices", ["paid_at"])
    op.create_index("idx_invoices_status", "invoices", ["status"])


def downgrade():
    op.drop_table("invoices")
