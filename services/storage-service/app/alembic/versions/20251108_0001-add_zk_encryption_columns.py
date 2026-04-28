"""add ZK encryption columns to objects table

Revision ID: 20251108_0001
Revises: 20251108_0000
Create Date: 2025-11-08

"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "20251108_0001"
down_revision = "20251108_0000"
branch_labels = None
depends_on = None


def upgrade():
    """Add Zero-Knowledge encryption columns to objects table"""
    # Add ZK encryption columns if they don't exist
    op.execute("ALTER TABLE objects ADD COLUMN IF NOT EXISTS is_encrypted BOOLEAN DEFAULT FALSE")
    op.execute("ALTER TABLE objects ADD COLUMN IF NOT EXISTS encrypted_file_key TEXT")
    op.execute("ALTER TABLE objects ADD COLUMN IF NOT EXISTS file_key_iv VARCHAR(255)")
    op.execute(
        "ALTER TABLE objects ADD COLUMN IF NOT EXISTS encryption_algorithm VARCHAR(50) DEFAULT 'AES-256-GCM'"
    )
    op.execute(
        "ALTER TABLE objects ADD COLUMN IF NOT EXISTS upload_status VARCHAR(20) DEFAULT 'completed'"
    )
    op.execute("ALTER TABLE objects ADD COLUMN IF NOT EXISTS upload_id VARCHAR(255)")
    op.execute("ALTER TABLE objects ADD COLUMN IF NOT EXISTS uploaded_at TIMESTAMP WITH TIME ZONE")
    op.execute("ALTER TABLE objects ADD COLUMN IF NOT EXISTS file_hash VARCHAR(128)")

    # Create index for encrypted files
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_objects_is_encrypted ON objects(is_encrypted) WHERE is_encrypted = TRUE"
    )


def downgrade():
    """Remove ZK encryption columns from objects table"""
    op.execute("DROP INDEX IF EXISTS idx_objects_is_encrypted")
    op.execute("ALTER TABLE objects DROP COLUMN IF EXISTS file_hash")
    op.execute("ALTER TABLE objects DROP COLUMN IF EXISTS uploaded_at")
    op.execute("ALTER TABLE objects DROP COLUMN IF EXISTS upload_id")
    op.execute("ALTER TABLE objects DROP COLUMN IF EXISTS upload_status")
    op.execute("ALTER TABLE objects DROP COLUMN IF EXISTS encryption_algorithm")
    op.execute("ALTER TABLE objects DROP COLUMN IF EXISTS file_key_iv")
    op.execute("ALTER TABLE objects DROP COLUMN IF EXISTS encrypted_file_key")
    op.execute("ALTER TABLE objects DROP COLUMN IF EXISTS is_encrypted")
