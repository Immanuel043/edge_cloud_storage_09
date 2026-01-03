"""Add email verification fields to users

Revision ID: add_email_verification_fields
Revises: separate_zk_cleanup
Create Date: 2025-01-01
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers
revision = 'add_email_verification_fields'
down_revision = 'separate_zk_cleanup'  # This should match the revision ID from 20251231_0100-separate_zk_cleanup.py
branch_labels = None
depends_on = None


def upgrade():
    """Add email verification fields to users table"""
    
    # Add email verification columns
    op.add_column('users', sa.Column('email_verified', sa.Boolean(), nullable=False, server_default='false'))
    op.add_column('users', sa.Column('verification_code', sa.String(length=6), nullable=True))
    op.add_column('users', sa.Column('verification_code_expires_at', sa.DateTime(timezone=True), nullable=True))
    op.add_column('users', sa.Column('verification_code_attempts', sa.Integer(), nullable=False, server_default='0'))
    
    # Add indexes for verification lookups
    op.create_index('idx_users_email_verified', 'users', ['email_verified'])
    op.create_index('idx_users_verification_code_expires', 'users', ['verification_code_expires_at'])


def downgrade():
    """Remove email verification fields"""
    
    op.drop_index('idx_users_verification_code_expires', table_name='users')
    op.drop_index('idx_users_email_verified', table_name='users')
    op.drop_column('users', 'verification_code_attempts')
    op.drop_column('users', 'verification_code_expires_at')
    op.drop_column('users', 'verification_code')
    op.drop_column('users', 'email_verified')

