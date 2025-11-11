"""add missing columns to recommendations table

Revision ID: 31f08c8dbc4a
Revises: d3db565fb90e
Create Date: 2025-11-09 12:32:49.696978

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '31f08c8dbc4a'
down_revision: Union[str, None] = 'd3db565fb90e'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Rename context_file_id to source_file_id (ORM expects this name)
    op.alter_column('recommendations', 'context_file_id', new_column_name='source_file_id')

    # Add missing columns to recommendations table
    op.add_column('recommendations', sa.Column('rank', sa.Integer(), nullable=True))
    op.add_column('recommendations', sa.Column('is_viewed', sa.Boolean(), server_default='false', nullable=True))
    op.add_column('recommendations', sa.Column('expires_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('recommendations', sa.Column('viewed_at', sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    # Remove columns added in upgrade
    op.drop_column('recommendations', 'viewed_at')
    op.drop_column('recommendations', 'expires_at')
    op.drop_column('recommendations', 'is_viewed')
    op.drop_column('recommendations', 'rank')

    # Rename back to original
    op.alter_column('recommendations', 'source_file_id', new_column_name='context_file_id')
