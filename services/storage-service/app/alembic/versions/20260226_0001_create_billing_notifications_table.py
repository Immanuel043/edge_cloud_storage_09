"""Create billing_notifications table

The billing schedulers require this table to track payment reminders
and notification history. Without it, both billing-scheduler and
zk-billing-scheduler fail on startup.

Revision ID: 20260226_0001
Revises: 20260220_0001
Create Date: 2026-02-26
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers
revision = "20260226_0001"
down_revision = "20260220_0001"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "billing_notifications",
        sa.Column(
            "id",
            postgresql.UUID(as_uuid=True),
            primary_key=True,
            server_default=sa.text("gen_random_uuid()"),
        ),
        # Reference
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("service_type", sa.String(20), nullable=False),
        sa.Column("subscription_id", postgresql.UUID(as_uuid=True)),
        # Notification Details
        sa.Column("notification_type", sa.String(50), nullable=False),
        sa.Column("billing_cycle", sa.String(20)),
        sa.Column("days_before_payment", sa.Integer()),
        # Payment Info
        sa.Column("amount_due", sa.Numeric(10, 2)),
        sa.Column("currency", sa.String(3), server_default="INR"),
        sa.Column("payment_due_date", sa.DateTime(timezone=True)),
        # Status
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("sent_at", sa.DateTime(timezone=True)),
        sa.Column("error_message", sa.Text()),
        # Metadata
        sa.Column("extra_metadata", postgresql.JSONB(), server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True)),
        # Foreign Keys
        sa.ForeignKeyConstraint(["subscription_id"], ["user_subscriptions.id"]),
        # Table comment
        comment="Billing notifications sent to users",
    )

    # Indexes
    op.create_index("idx_notifications_user", "billing_notifications", ["user_id", "service_type"])
    op.create_index("idx_notifications_subscription", "billing_notifications", ["subscription_id"])
    op.create_index("idx_notifications_status", "billing_notifications", ["status"])
    op.create_index("idx_notifications_due_date", "billing_notifications", ["payment_due_date"])
    op.create_index("idx_notifications_type", "billing_notifications", ["notification_type"])


def downgrade():
    op.drop_table("billing_notifications")
