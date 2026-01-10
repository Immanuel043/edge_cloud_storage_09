"""add email verification fields to zk_users

Revision ID: 20260110_0004
Revises: 20260110_0003
Create Date: 2026-01-10

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '20260110_0004'
down_revision = '20260110_0003'
branch_labels = None
depends_on = None


def upgrade():
    """Add email verification fields to zk_users table."""

    # Add email_verified field
    op.add_column(
        'zk_users',
        sa.Column('email_verified', sa.Boolean(), nullable=False, server_default='false')
    )

    # Add verification_code field
    op.add_column(
        'zk_users',
        sa.Column('verification_code', sa.String(6), nullable=True)
    )

    # Add verification_code_expires_at field
    op.add_column(
        'zk_users',
        sa.Column('verification_code_expires_at', sa.DateTime(timezone=True), nullable=True)
    )

    # Add verification_code_attempts field
    op.add_column(
        'zk_users',
        sa.Column('verification_code_attempts', sa.Integer(), nullable=False, server_default='0')
    )

    # Create indexes for efficient queries
    op.create_index(
        'idx_zk_users_email_verified',
        'zk_users',
        ['email_verified']
    )

    op.create_index(
        'idx_zk_users_verification_code_expires',
        'zk_users',
        ['verification_code_expires_at']
    )


def downgrade():
    """Remove email verification fields from zk_users table."""

    # Drop indexes
    op.drop_index('idx_zk_users_verification_code_expires', table_name='zk_users')
    op.drop_index('idx_zk_users_email_verified', table_name='zk_users')

    # Drop columns
    op.drop_column('zk_users', 'verification_code_attempts')
    op.drop_column('zk_users', 'verification_code_expires_at')
    op.drop_column('zk_users', 'verification_code')
    op.drop_column('zk_users', 'email_verified')
