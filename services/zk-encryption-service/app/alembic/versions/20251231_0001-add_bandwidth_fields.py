"""Add bandwidth override fields to ZK users

Revision ID: add_bandwidth_fields
Revises: init_zk_database
Create Date: 2025-12-31
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers
revision = 'add_bandwidth_fields'
down_revision = 'init_zk_database'
branch_labels = None
depends_on = None


def upgrade():
    """Add bandwidth throttling override fields to zk_users table"""
    
    # Add bandwidth override columns (NULL = use plan default)
    op.add_column('zk_users', sa.Column('bandwidth_limit_mbps', sa.Integer(), nullable=True))
    op.add_column('zk_users', sa.Column('bandwidth_burst_mbps', sa.Integer(), nullable=True))
    op.add_column('zk_users', sa.Column('max_concurrent_streams', sa.Integer(), nullable=True))


def downgrade():
    """Remove bandwidth throttling override fields"""
    
    op.drop_column('zk_users', 'max_concurrent_streams')
    op.drop_column('zk_users', 'bandwidth_burst_mbps')
    op.drop_column('zk_users', 'bandwidth_limit_mbps')

