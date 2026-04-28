"""create refunds table

Revision ID: 20260110_0003
Revises: 20260110_0002
Create Date: 2026-01-10

"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

# revision identifiers, used by Alembic.
revision = "20260110_0003"
down_revision = "20260110_0002"
branch_labels = None
depends_on = None


def upgrade():
    """Create refunds table for refund management."""

    op.create_table(
        "refunds",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        # Request details
        sa.Column("user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("subscription_id", UUID(as_uuid=True), nullable=False),
        sa.Column("payment_id", sa.String(255), nullable=False),
        # Refund amount
        sa.Column("original_amount", sa.Numeric(10, 2), nullable=False),
        sa.Column("refund_amount", sa.Numeric(10, 2), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False),
        # Status and reason
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("reason", sa.String(50), nullable=False),
        sa.Column("user_notes", sa.Text, nullable=True),
        sa.Column("admin_notes", sa.Text, nullable=True),
        # Gateway details
        sa.Column("gateway", sa.String(20), nullable=False),
        sa.Column("gateway_refund_id", sa.String(255), nullable=True),
        # Approval
        sa.Column("approved_by", UUID(as_uuid=True), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        # Processing
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
        # Error handling
        sa.Column("error_message", sa.Text, nullable=True),
        sa.Column("retry_count", sa.Integer, server_default="0"),
        # Timestamps
        sa.Column(
            "requested_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            onupdate=sa.func.now(),
        ),
        # Eligibility
        sa.Column("payment_date", sa.DateTime(timezone=True), nullable=False),
        sa.Column("is_within_policy", sa.Boolean, server_default="true"),
    )

    # Create indexes
    op.create_index("idx_refunds_user_id", "refunds", ["user_id"])
    op.create_index("idx_refunds_subscription_id", "refunds", ["subscription_id"])
    op.create_index("idx_refunds_payment_id", "refunds", ["payment_id"])
    op.create_index("idx_refunds_status", "refunds", ["status"])
    op.create_index("idx_refunds_gateway_refund_id", "refunds", ["gateway_refund_id"])
    op.create_index("idx_refunds_user_status", "refunds", ["user_id", "status"])
    op.create_index("idx_refunds_gateway", "refunds", ["gateway"])
    op.create_index("idx_refunds_requested_at", "refunds", ["requested_at"])


def downgrade():
    """Drop refunds table."""

    op.drop_index("idx_refunds_requested_at", table_name="refunds")
    op.drop_index("idx_refunds_gateway", table_name="refunds")
    op.drop_index("idx_refunds_user_status", table_name="refunds")
    op.drop_index("idx_refunds_gateway_refund_id", table_name="refunds")
    op.drop_index("idx_refunds_status", table_name="refunds")
    op.drop_index("idx_refunds_payment_id", table_name="refunds")
    op.drop_index("idx_refunds_subscription_id", table_name="refunds")
    op.drop_index("idx_refunds_user_id", table_name="refunds")
    op.drop_table("refunds")
