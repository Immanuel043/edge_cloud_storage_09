"""Add file_summaries and file_name_suggestions tables for AI features

Revision ID: 20260324_0001
Revises: 20260322_0001
Create Date: 2026-03-24
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers
revision = '20260324_0001'
down_revision = '20260322_0001'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # file_summaries — caches AI/TF-IDF generated summaries per file
    op.create_table(
        'file_summaries',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text('gen_random_uuid()')),
        sa.Column('file_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('objects.id', ondelete='CASCADE'),
                  nullable=False, unique=True),
        sa.Column('summary', sa.Text, nullable=False),
        sa.Column('word_count', sa.Integer),
        sa.Column('model_used', sa.String(100)),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.func.now()),
    )
    op.create_index('idx_file_summaries_file_id', 'file_summaries', ['file_id'])

    # file_name_suggestions — AI-generated rename suggestions
    op.create_table(
        'file_name_suggestions',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text('gen_random_uuid()')),
        sa.Column('file_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('objects.id', ondelete='CASCADE'),
                  nullable=False, unique=True),
        sa.Column('suggested_name', sa.String(500), nullable=False),
        sa.Column('reason', sa.Text),
        sa.Column('source', sa.String(50)),  # 'ocr_title', 'ai_tags', 'exif_date', 'llm', etc.
        sa.Column('is_accepted', sa.Boolean, server_default='false'),
        sa.Column('is_dismissed', sa.Boolean, server_default='false'),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.func.now()),
    )
    op.create_index('idx_file_name_suggestions_file_id',
                    'file_name_suggestions', ['file_id'])


def downgrade() -> None:
    op.drop_index('idx_file_name_suggestions_file_id',
                  table_name='file_name_suggestions')
    op.drop_table('file_name_suggestions')
    op.drop_index('idx_file_summaries_file_id', table_name='file_summaries')
    op.drop_table('file_summaries')
