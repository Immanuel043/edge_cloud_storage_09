"""add encryption_version column to objects table

Revision ID: 20251223_0000
Revises: 20251216_0000
Create Date: 2025-12-23

Adds encryption_version column to track V1 (basic) vs V2 (HKDF+AAD) encryption.
This enables gradual migration of existing V1 encrypted files to V2.
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "20251223_0000"
down_revision = "20251216_0000"
branch_labels = None
depends_on = None


def upgrade():
    """Add encryption_version column to objects table"""
    # Add encryption_version column with default 1 (V1 - legacy)
    # V1 = basic AES-256-GCM encryption
    # V2 = HKDF-based key hierarchy + AAD in chunk encryption
    op.execute("""
        ALTER TABLE objects
        ADD COLUMN IF NOT EXISTS encryption_version INTEGER DEFAULT 1
    """)

    # Create partial index for encrypted files that need migration
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_objects_encryption_version
        ON objects(encryption_version)
        WHERE is_encrypted = TRUE AND encryption_version = 1
    """)


def downgrade():
    """Remove encryption_version column from objects table"""
    op.execute("DROP INDEX IF EXISTS idx_objects_encryption_version")
    op.execute("ALTER TABLE objects DROP COLUMN IF EXISTS encryption_version")
