"""add video optimization columns to users and objects tables

Revision ID: 20251224_0000
Revises: 20251223_0000
Create Date: 2025-12-24

Adds columns for proactive video optimization pipeline:
- User.video_optimization_mode: User preference for video processing
- Object.video_processing_status: Processing status (queued/processing/ready/failed)
- Object.video_processing_error: Error message if failed
- Object.video_processing_progress: Progress percentage (0-100)
- Object.optimized_path: Path to transcoded/optimized version
- Object.optimized_size: Size of optimized version in bytes
- Object.video_processed_at: Timestamp when processing completed
"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "20251224_0000"
down_revision = "20251223_0000"
branch_labels = None
depends_on = None


def upgrade():
    """Add video optimization columns to users and objects tables"""

    # Add video_optimization_mode to users table
    op.execute("""
        ALTER TABLE users
        ADD COLUMN IF NOT EXISTS video_optimization_mode VARCHAR(20) DEFAULT 'keep_both' NOT NULL
    """)

    # Add video processing columns to objects table
    op.execute("""
        ALTER TABLE objects
        ADD COLUMN IF NOT EXISTS video_processing_status VARCHAR(20) DEFAULT NULL
    """)

    op.execute("""
        ALTER TABLE objects
        ADD COLUMN IF NOT EXISTS video_processing_error TEXT DEFAULT NULL
    """)

    op.execute("""
        ALTER TABLE objects
        ADD COLUMN IF NOT EXISTS video_processing_progress INTEGER DEFAULT NULL
    """)

    op.execute("""
        ALTER TABLE objects
        ADD COLUMN IF NOT EXISTS optimized_path VARCHAR(500) DEFAULT NULL
    """)

    op.execute("""
        ALTER TABLE objects
        ADD COLUMN IF NOT EXISTS optimized_size BIGINT DEFAULT NULL
    """)

    op.execute("""
        ALTER TABLE objects
        ADD COLUMN IF NOT EXISTS video_processed_at TIMESTAMP DEFAULT NULL
    """)

    # Create index for video processing status queries
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_objects_video_processing_status
        ON objects(video_processing_status)
        WHERE video_processing_status IS NOT NULL
    """)

    # Create index for finding videos that need processing (queued status)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_objects_video_queued
        ON objects(video_processing_status, created_at)
        WHERE video_processing_status = 'queued'
    """)


def downgrade():
    """Remove video optimization columns from users and objects tables"""
    # Drop indexes first
    op.execute("DROP INDEX IF EXISTS idx_objects_video_queued")
    op.execute("DROP INDEX IF EXISTS idx_objects_video_processing_status")

    # Drop columns from objects table
    op.execute("ALTER TABLE objects DROP COLUMN IF EXISTS video_processed_at")
    op.execute("ALTER TABLE objects DROP COLUMN IF EXISTS optimized_size")
    op.execute("ALTER TABLE objects DROP COLUMN IF EXISTS optimized_path")
    op.execute("ALTER TABLE objects DROP COLUMN IF EXISTS video_processing_progress")
    op.execute("ALTER TABLE objects DROP COLUMN IF EXISTS video_processing_error")
    op.execute("ALTER TABLE objects DROP COLUMN IF EXISTS video_processing_status")

    # Drop column from users table
    op.execute("ALTER TABLE users DROP COLUMN IF EXISTS video_optimization_mode")
