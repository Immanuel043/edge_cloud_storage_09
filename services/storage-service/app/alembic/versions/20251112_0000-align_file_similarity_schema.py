"""Align file_similarities schema with ORM expectations

Revision ID: 20251112_0000
Revises: 20251108_0001
Create Date: 2025-11-12
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = '20251112_0000'
down_revision = '20251108_0001'
branch_labels = None
depends_on = None


def _column_exists(inspector, table_name: str, column_name: str) -> bool:
    columns = inspector.get_columns(table_name)
    return any(col["name"] == column_name for col in columns)


def upgrade():
    """Bring file_similarities table in sync with SQLAlchemy model."""
    bind = op.get_bind()
    inspector = inspect(bind)

    # Add new columns when missing
    if not _column_exists(inspector, 'file_similarities', 'user_id'):
        op.add_column(
            'file_similarities',
            sa.Column('user_id', postgresql.UUID(as_uuid=True), nullable=True)
        )

    if not _column_exists(inspector, 'file_similarities', 'name_similarity'):
        op.add_column(
            'file_similarities',
            sa.Column('name_similarity', sa.Float(), nullable=True)
        )

    if not _column_exists(inspector, 'file_similarities', 'type_match'):
        op.add_column(
            'file_similarities',
            sa.Column('type_match', sa.Boolean(), server_default=sa.text('false'), nullable=True)
        )

    if not _column_exists(inspector, 'file_similarities', 'created_at'):
        op.add_column(
            'file_similarities',
            sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True)
        )

    if not _column_exists(inspector, 'file_similarities', 'updated_at'):
        op.add_column(
            'file_similarities',
            sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=True)
        )

    # Refresh inspector metadata after new columns may have been added
    inspector = inspect(bind)

    connection = bind

    # Backfill user_id using file ownership
    connection.execute(sa.text("""
        UPDATE file_similarities fs
        SET user_id = o.user_id
        FROM objects o
        WHERE fs.user_id IS NULL AND fs.file_id = o.id
    """))

    connection.execute(sa.text("""
        UPDATE file_similarities fs
        SET user_id = o.user_id
        FROM objects o
        WHERE fs.user_id IS NULL AND fs.similar_file_id = o.id
    """))

    # Drop orphaned rows that cannot be linked to a user
    connection.execute(sa.text("""
        DELETE FROM file_similarities
        WHERE user_id IS NULL
    """))

    # Normalize metadata columns
    connection.execute(sa.text("""
        UPDATE file_similarities
        SET created_at = COALESCE(created_at, computed_at, NOW()),
            updated_at = COALESCE(updated_at, computed_at, NOW())
    """))

    connection.execute(sa.text("""
        UPDATE file_similarities
        SET type_match = FALSE
        WHERE type_match IS NULL
    """))

    # Enforce NOT NULL on user_id when possible
    remaining_nulls = connection.execute(
        sa.text("SELECT COUNT(*) FROM file_similarities WHERE user_id IS NULL")
    ).scalar()

    if remaining_nulls == 0:
        op.alter_column(
            'file_similarities',
            'user_id',
            existing_type=postgresql.UUID(as_uuid=True),
            nullable=False
        )
    else:
        print(
            f"⚠️  file_similarities.user_id still has {remaining_nulls} NULL rows; "
            "leaving column nullable to avoid data loss."
        )

    # Ensure indexes/constraints exist
    indexes = {idx['name'] for idx in inspector.get_indexes('file_similarities')}
    if 'idx_file_sim_user_id' not in indexes:
        op.create_index('idx_file_sim_user_id', 'file_similarities', ['user_id'])

    foreign_keys = {fk['name'] for fk in inspector.get_foreign_keys('file_similarities')}
    if 'fk_file_similarities_user_id' not in foreign_keys:
        op.create_foreign_key(
            'fk_file_similarities_user_id',
            'file_similarities',
            'users',
            ['user_id'],
            ['id'],
            ondelete='CASCADE'
        )


def downgrade():
    """Revert schema changes."""
    bind = op.get_bind()
    inspector = inspect(bind)

    indexes = {idx['name'] for idx in inspector.get_indexes('file_similarities')}
    if 'idx_file_sim_user_id' in indexes:
        op.drop_index('idx_file_sim_user_id', table_name='file_similarities')

    foreign_keys = {fk['name'] for fk in inspector.get_foreign_keys('file_similarities')}
    if 'fk_file_similarities_user_id' in foreign_keys:
        op.drop_constraint('fk_file_similarities_user_id', 'file_similarities', type_='foreignkey')

    columns_to_drop = [
        'updated_at',
        'created_at',
        'type_match',
        'name_similarity',
        'user_id'
    ]

    existing_columns = {col['name'] for col in inspector.get_columns('file_similarities')}
    for column in columns_to_drop:
        if column in existing_columns:
            op.drop_column('file_similarities', column)
