# services/storage-service/app/utils/resolved_file_view.py

"""
Read-only snapshot of a file's storage attributes for download / preview.

For deduplicated_reference files the storage fields (encryption_key,
chunk_info, storage_type, object_path) come from the *reference* file while
identity fields (id, file_name, file_size, …) stay from the original record.

This avoids mutating session-tracked SQLAlchemy objects which would either
corrupt the DB on commit or raise DetachedInstanceError after expunge.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any, Dict, Optional

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)


@dataclass(frozen=True, slots=True)
class ResolvedFileView:
    # Identity / metadata (always from the user's file)
    id: Any
    file_name: str
    file_size: int
    mime_type: Optional[str]
    user_id: Any

    # Storage fields (swapped from reference for deduplicated_reference)
    encryption_key: Optional[bytes]
    chunk_info: Optional[Dict]
    storage_type: str
    object_path: Optional[str]
    storage_key: Optional[str]

    # Extra metadata used by preview / transcoder
    file_metadata: Optional[Dict]
    dedup_info: Optional[Dict]
    content_hash: Optional[str]

    # True when storage_type was deduplicated_reference but the target is gone
    dangling_reference: bool = False

    @staticmethod
    async def resolve(file_obj, db: AsyncSession) -> "ResolvedFileView":
        """Build a ResolvedFileView, resolving dedup references when needed."""
        from ..models.database import Object  # local import to avoid circular

        enc_key = file_obj.encryption_key
        chunk_info = file_obj.chunk_info
        storage_type = file_obj.storage_type
        object_path = file_obj.object_path

        dangling = False

        # Post-migration: no deduplicated_reference files should exist.
        # Keep fallback with warning for safety.
        if storage_type == "deduplicated_reference" and file_obj.dedup_info:
            logger.warning("Unmigrated deduplicated_reference: %s", file_obj.id)
            ref_id = file_obj.dedup_info.get("reference_file_id")
            if ref_id:
                ref_result = await db.execute(select(Object).filter(Object.id == ref_id))
                ref_file = ref_result.scalar_one_or_none()
                if ref_file:
                    enc_key = ref_file.encryption_key
                    chunk_info = ref_file.chunk_info
                    storage_type = ref_file.storage_type
                    object_path = ref_file.object_path
                else:
                    dangling = True

        return ResolvedFileView(
            id=file_obj.id,
            file_name=file_obj.file_name,
            file_size=file_obj.file_size,
            mime_type=file_obj.mime_type,
            user_id=file_obj.user_id,
            encryption_key=enc_key,
            chunk_info=chunk_info,
            storage_type=storage_type,
            object_path=object_path,
            storage_key=file_obj.storage_key,
            file_metadata=file_obj.file_metadata,
            dedup_info=file_obj.dedup_info,
            content_hash=file_obj.content_hash,
            dangling_reference=dangling,
        )
