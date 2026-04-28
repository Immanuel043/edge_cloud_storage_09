"""add ai analysis tables

Revision ID: ai_analysis_001
Revises: 7209ad64a320
Create Date: 2025-10-05 18:00:00.000000

"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "ai_analysis_001"
down_revision = "7209ad64a320"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create file_ocr table
    op.create_table(
        "file_ocr",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("extracted_text", sa.Text(), nullable=False),
        sa.Column("word_count", sa.Integer(), default=0),
        sa.Column("confidence", sa.Integer(), default=0),
        sa.Column("ocr_engine", sa.String(50), default="tesseract"),
        sa.Column("languages", postgresql.JSON),
        sa.Column("page_count", sa.Integer(), default=1),
        sa.Column("extraction_method", sa.String(50)),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.Column(
            "updated_at", sa.DateTime(), server_default=sa.text("now()"), onupdate=sa.text("now()")
        ),
        sa.ForeignKeyConstraint(["file_id"], ["objects.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("file_id", name="uq_file_ocr_file_id"),
    )
    op.create_index("idx_file_ocr_file_id", "file_ocr", ["file_id"])

    # Create file_metadata_extended table
    op.create_table(
        "file_metadata_extended",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("metadata_type", sa.String(50)),
        sa.Column("raw_metadata", postgresql.JSONB),
        sa.Column("width", sa.Integer()),
        sa.Column("height", sa.Integer()),
        sa.Column("duration", sa.Integer()),
        sa.Column("page_count", sa.Integer()),
        sa.Column("camera_make", sa.String(100)),
        sa.Column("camera_model", sa.String(100)),
        sa.Column("date_taken", sa.DateTime()),
        sa.Column("gps_latitude", sa.String(50)),
        sa.Column("gps_longitude", sa.String(50)),
        sa.Column("artist", sa.String(255)),
        sa.Column("album", sa.String(255)),
        sa.Column("title", sa.String(255)),
        sa.Column("genre", sa.String(100)),
        sa.Column("bitrate", sa.Integer()),
        sa.Column("author", sa.String(255)),
        sa.Column("word_count", sa.Integer()),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.Column(
            "updated_at", sa.DateTime(), server_default=sa.text("now()"), onupdate=sa.text("now()")
        ),
        sa.ForeignKeyConstraint(["file_id"], ["objects.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("file_id", name="uq_file_metadata_file_id"),
    )
    op.create_index("idx_file_metadata_file_id", "file_metadata_extended", ["file_id"])
    op.create_index("idx_file_metadata_type", "file_metadata_extended", ["metadata_type"])
    op.create_index("idx_file_metadata_artist", "file_metadata_extended", ["artist"])
    op.create_index("idx_file_metadata_author", "file_metadata_extended", ["author"])

    # Create file_hashes table
    op.create_table(
        "file_hashes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("phash", sa.String(64)),
        sa.Column("dhash", sa.String(64)),
        sa.Column("whash", sa.String(64)),
        sa.Column("average_hash", sa.String(64)),
        sa.Column("colorhash", sa.String(64)),
        sa.Column("text_hash", sa.String(64)),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["file_id"], ["objects.id"], ondelete="CASCADE"),
        sa.UniqueConstraint("file_id", name="uq_file_hash_file_id"),
    )
    op.create_index("idx_file_hash_file_id", "file_hashes", ["file_id"])
    op.create_index("idx_file_hash_phash", "file_hashes", ["phash"])
    op.create_index("idx_file_hash_dhash", "file_hashes", ["dhash"])

    # Create file_tags table
    op.create_table(
        "file_tags",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("file_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("tag", sa.String(100), nullable=False),
        sa.Column("confidence", sa.Integer(), default=100),
        sa.Column("source", sa.String(50), default="manual"),
        sa.Column("created_by", postgresql.UUID(as_uuid=True)),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.ForeignKeyConstraint(["file_id"], ["objects.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.UniqueConstraint("file_id", "tag", name="unique_file_tag"),
    )
    op.create_index("idx_file_tag_file_id", "file_tags", ["file_id"])
    op.create_index("idx_file_tag_tag", "file_tags", ["tag"])
    op.create_index("idx_file_tag_source", "file_tags", ["source"])


def downgrade() -> None:
    op.drop_table("file_tags")
    op.drop_table("file_hashes")
    op.drop_table("file_metadata_extended")
    op.drop_table("file_ocr")
