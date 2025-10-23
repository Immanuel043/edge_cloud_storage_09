"""add url_upload_jobs table

Revision ID: 20251023_0003
Revises: 20251023_0002
Create Date: 2025-10-23

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


# revision identifiers, used by Alembic.
revision = '20251023_0003'
down_revision = '20251023_0002'
branch_labels = None
depends_on = None


def upgrade():
    """Add url_upload_jobs table for URL-based file uploads"""
    op.execute("""
        CREATE TABLE IF NOT EXISTS url_upload_jobs (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            folder_id UUID REFERENCES folders(id) ON DELETE SET NULL,
            file_id UUID REFERENCES objects(id) ON DELETE SET NULL,

            -- URL and metadata
            source_url TEXT NOT NULL,
            filename VARCHAR(255),
            mime_type VARCHAR(100),

            -- Status tracking
            status VARCHAR(20) DEFAULT 'pending' NOT NULL,
            progress INTEGER DEFAULT 0,
            total_size BIGINT DEFAULT 0,
            downloaded_size BIGINT DEFAULT 0,

            -- Error handling
            error_message TEXT,
            retry_count INTEGER DEFAULT 0,

            -- Timestamps
            created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL,
            started_at TIMESTAMP WITH TIME ZONE,
            completed_at TIMESTAMP WITH TIME ZONE,
            updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW() NOT NULL
        );
    """)

    # Create indexes for performance
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_url_upload_jobs_user_id ON url_upload_jobs(user_id);
        CREATE INDEX IF NOT EXISTS idx_url_upload_jobs_file_id ON url_upload_jobs(file_id);
        CREATE INDEX IF NOT EXISTS idx_url_upload_jobs_status ON url_upload_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_url_upload_jobs_created_at ON url_upload_jobs(created_at);
    """)


def downgrade():
    """Remove url_upload_jobs table"""
    op.execute("DROP TABLE IF EXISTS url_upload_jobs CASCADE;")
