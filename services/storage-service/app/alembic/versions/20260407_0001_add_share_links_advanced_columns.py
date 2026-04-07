"""add missing sharing columns to share_links, share_bundles, shared_access

Revision ID: 20260407_0001
Revises: 20260406_0001
Create Date: 2026-04-07

Changes:
- Add notify_on_access, allowed_ips, watermark_text to share_links and share_bundles
- Add bundle_id FK to shared_access
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


# revision identifiers, used by Alembic.
revision = '20260407_0001'
down_revision = '20260406_0001'
branch_labels = None
depends_on = None


def upgrade() -> None:
    conn = op.get_bind()
    # Idempotent: only add columns if they don't already exist
    existing = conn.execute(sa.text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'share_links' AND column_name IN "
        "('notify_on_access', 'allowed_ips', 'watermark_text')"
    )).scalars().all()

    if 'notify_on_access' not in existing:
        op.add_column('share_links', sa.Column('notify_on_access', sa.Boolean, server_default='false'))
    if 'allowed_ips' not in existing:
        op.add_column('share_links', sa.Column('allowed_ips', sa.JSON, nullable=True))
    if 'watermark_text' not in existing:
        op.add_column('share_links', sa.Column('watermark_text', sa.String(255), nullable=True))

    # Also add to share_bundles
    existing_bundles = conn.execute(sa.text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'share_bundles' AND column_name IN "
        "('notify_on_access', 'allowed_ips', 'watermark_text')"
    )).scalars().all()

    if 'notify_on_access' not in existing_bundles:
        op.add_column('share_bundles', sa.Column('notify_on_access', sa.Boolean, server_default='false'))
    if 'allowed_ips' not in existing_bundles:
        op.add_column('share_bundles', sa.Column('allowed_ips', sa.JSON, nullable=True))
    if 'watermark_text' not in existing_bundles:
        op.add_column('share_bundles', sa.Column('watermark_text', sa.String(255), nullable=True))

    # Add bundle_id to shared_access
    existing_sa = conn.execute(sa.text(
        "SELECT column_name FROM information_schema.columns "
        "WHERE table_name = 'shared_access' AND column_name = 'bundle_id'"
    )).scalars().all()

    if 'bundle_id' not in existing_sa:
        op.add_column('shared_access', sa.Column('bundle_id', UUID(as_uuid=True), nullable=True))
        op.create_foreign_key(
            'shared_access_bundle_id_fkey',
            'shared_access', 'share_bundles',
            ['bundle_id'], ['id'],
            ondelete='CASCADE',
        )
        op.create_index('idx_shared_bundle', 'shared_access', ['bundle_id'])


def downgrade() -> None:
    op.drop_index('idx_shared_bundle', table_name='shared_access')
    op.drop_constraint('shared_access_bundle_id_fkey', 'shared_access', type_='foreignkey')
    op.drop_column('shared_access', 'bundle_id')
    op.drop_column('share_bundles', 'watermark_text')
    op.drop_column('share_bundles', 'allowed_ips')
    op.drop_column('share_bundles', 'notify_on_access')
    op.drop_column('share_links', 'watermark_text')
    op.drop_column('share_links', 'allowed_ips')
    op.drop_column('share_links', 'notify_on_access')
