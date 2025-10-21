"""add_oauth_accounts_table

Revision ID: oauth_accounts_001
Revises: favorites_001
Create Date: 2025-10-20

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'oauth_accounts_001'
down_revision = 'favorites_001'
branch_labels = None
depends_on = None


def upgrade():
    # Create oauth_accounts table
    op.create_table(
        'oauth_accounts',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
        sa.Column('provider', sa.String(50), nullable=False),
        sa.Column('provider_user_id', sa.String(255), nullable=False),
        sa.Column('access_token', sa.Text(), nullable=True),
        sa.Column('refresh_token', sa.Text(), nullable=True),
        sa.Column('token_expires_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('profile_data', postgresql.JSON, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), onupdate=sa.func.now()),
    )

    # Create indexes
    op.create_index('idx_oauth_provider_user', 'oauth_accounts', ['provider', 'provider_user_id'])
    op.create_unique_constraint('uq_oauth_provider_user', 'oauth_accounts', ['provider', 'provider_user_id'])


def downgrade():
    # Drop oauth_accounts table
    op.drop_table('oauth_accounts')
