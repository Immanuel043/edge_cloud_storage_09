"""create audit logs table

Revision ID: 20260110_0001
Revises: 20260109_0003
Create Date: 2026-01-10

NOTE: This migration was originally creating a DIFFERENT audit_logs schema
that conflicted with the ORM model (database.py AuditLog class). The correct
schema is created by migration 20251021_0002. This migration is now a no-op
since the ORM-matching schema is already created by that earlier migration.
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '20260110_0001'
down_revision = '20260109_0003'
branch_labels = None
depends_on = None


def upgrade():
    """No-op: audit_logs table already created by migration 20251021_0002 with correct schema."""
    pass


def downgrade():
    """No-op: audit_logs table managed by migration 20251021_0002."""
    pass
