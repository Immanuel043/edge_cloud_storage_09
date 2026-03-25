"""
Smart file naming service.

Detects generic filenames and generates meaningful alternatives from
OCR title, AI tags, EXIF date, audio metadata, or LLM.
"""
import logging
import os
import re
from datetime import datetime
from uuid import uuid4
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from ..models.database import (
    Object, FileOCR, FileMetadata, FileTag, FileNameSuggestion,
)
from ..config import settings

logger = logging.getLogger(__name__)

# Max 255 chars to match rename validation (files.py:1536)
_MAX_NAME_LENGTH = 255

# Patterns that indicate a generic/camera-generated filename
_GENERIC_PATTERNS = [
    re.compile(r'^IMG[-_]?\d+', re.IGNORECASE),
    re.compile(r'^DSC[-_]?\d+', re.IGNORECASE),
    re.compile(r'^DCIM[-_]?\d+', re.IGNORECASE),
    re.compile(r'^P\d{8}[-_]\d+', re.IGNORECASE),
    re.compile(r'^Screenshot[-_ ]\d{4}', re.IGNORECASE),
    re.compile(r'^Screen[-_ ]?Shot', re.IGNORECASE),
    re.compile(r'^Photo[-_ ]?\d', re.IGNORECASE),
    re.compile(r'^image[-_ ]?\d', re.IGNORECASE),
    re.compile(r'^video[-_ ]?\d', re.IGNORECASE),
    re.compile(r'^audio[-_ ]?\d', re.IGNORECASE),
    re.compile(r'^recording[-_ ]?\d', re.IGNORECASE),
    re.compile(r'^VID[-_]?\d+', re.IGNORECASE),
    re.compile(r'^MOV[-_]?\d+', re.IGNORECASE),
    re.compile(r'^document[-_ ]?\d', re.IGNORECASE),
    re.compile(r'^scan[-_ ]?\d', re.IGNORECASE),
    re.compile(r'^file[-_ ]?\d', re.IGNORECASE),
    re.compile(r'^Untitled', re.IGNORECASE),
    re.compile(r'^New[-_ ]?File', re.IGNORECASE),
    re.compile(r'^Copy[-_ ]of', re.IGNORECASE),
    re.compile(r'^\d{8}[-_]\d{6}'),  # Timestamp-only names like 20260324_120000
    re.compile(r'^[0-9a-f]{8,}', re.IGNORECASE),  # Hash-like names
]

# Characters not allowed in filenames
_INVALID_CHARS = re.compile(r'[<>:"/\\|?*]')


def is_generic_name(filename: str) -> bool:
    """Check if a filename looks generic/auto-generated."""
    base = os.path.splitext(filename)[0]
    return any(p.match(base) for p in _GENERIC_PATTERNS)


def _sanitize_name(name: str, extension: str) -> str:
    """Sanitize and truncate a suggested name to ≤255 chars, preserving extension."""
    # Remove invalid characters
    name = _INVALID_CHARS.sub('', name).strip()
    # Remove leading/trailing dots and spaces
    name = name.strip('. ')

    if not name:
        return ""

    full = f"{name}{extension}" if extension else name
    if len(full) <= _MAX_NAME_LENGTH:
        return full

    # Truncate base name, preserve extension
    max_base = _MAX_NAME_LENGTH - len(extension)
    if max_base < 1:
        return name[:_MAX_NAME_LENGTH]
    return f"{name[:max_base]}{extension}"


async def _generate_name_from_metadata(
    file_obj: Object,
    db: AsyncSession,
) -> tuple[str, str, str] | None:
    """
    Try to generate a descriptive name from available analysis data.
    Returns (suggested_name, reason, source) or None.
    """
    extension = os.path.splitext(file_obj.file_name)[1]

    # 1. Try OCR title (first line of extracted text, if it looks like a title)
    result = await db.execute(
        select(FileOCR).filter(FileOCR.file_id == str(file_obj.id))
    )
    ocr = result.scalar_one_or_none()
    if ocr and ocr.extracted_text:
        first_line = ocr.extracted_text.strip().split('\n')[0].strip()
        # Use first line as title if it's reasonably short and text-like
        if 3 <= len(first_line) <= 120 and not first_line.startswith('{'):
            name = _sanitize_name(first_line, extension)
            if name:
                return name, f"Based on document title: \"{first_line[:80]}\"", "ocr_title"

    # 2. Try metadata title (from EXIF/audio metadata)
    result = await db.execute(
        select(FileMetadata).filter(FileMetadata.file_id == str(file_obj.id))
    )
    metadata = result.scalar_one_or_none()
    if metadata:
        # Audio/video title
        if metadata.title and len(metadata.title) >= 3:
            name = _sanitize_name(metadata.title, extension)
            if name:
                reason = f"Based on media title: \"{metadata.title[:80]}\""
                return name, reason, "metadata_title"

        # EXIF date for images
        if metadata.date_taken:
            try:
                dt = metadata.date_taken if isinstance(metadata.date_taken, datetime) else datetime.fromisoformat(str(metadata.date_taken))
                date_str = dt.strftime("%Y-%m-%d_%H%M")
                camera = ""
                if metadata.camera_make:
                    camera = f"_{metadata.camera_make.strip()}"
                name = _sanitize_name(f"Photo_{date_str}{camera}", extension)
                if name:
                    return name, f"Based on capture date: {dt.strftime('%B %d, %Y')}", "exif_date"
            except (ValueError, AttributeError):
                pass

    # 3. Try AI tags to build a descriptive name
    result = await db.execute(
        select(FileTag)
        .filter(FileTag.file_id == str(file_obj.id), FileTag.confidence >= 70)
        .order_by(FileTag.confidence.desc())
        .limit(3)
    )
    tags = result.scalars().all()
    if tags:
        tag_words = [t.tag.replace(' ', '_') for t in tags]
        combined = "_".join(tag_words)
        name = _sanitize_name(combined, extension)
        if name:
            return name, f"Based on detected content: {', '.join(t.tag for t in tags)}", "ai_tags"

    # 4. Try LLM if enabled and OCR text is available
    if settings.LLM_ENABLED and ocr and ocr.extracted_text:
        try:
            from .llm_client import llm_client
            if await llm_client.is_available():
                prompt = (
                    f"Based on this document text, suggest a concise, descriptive filename "
                    f"(max 60 chars, no extension). Just the filename, nothing else.\n\n"
                    f"{ocr.extracted_text[:2000]}"
                )
                suggested = await llm_client.complete(
                    "You are a filename generator. Return ONLY the suggested filename with no quotes or explanation.",
                    prompt,
                    max_tokens=30,
                )
                suggested = suggested.strip().strip('"\'')
                if suggested and 3 <= len(suggested) <= 120:
                    name = _sanitize_name(suggested, extension)
                    if name:
                        return name, f"AI-generated name based on content", "llm"
        except Exception as e:
            logger.warning(f"LLM naming failed for {file_obj.id}: {e}")

    return None


async def suggest_name_if_eligible(file_id: str, db: AsyncSession) -> dict | None:
    """
    Generate a name suggestion for a file if it has a generic name.
    Called from both analysis paths. Best-effort — returns None on skip/failure.
    """
    try:
        result = await db.execute(select(Object).filter(Object.id == file_id))
        file_obj = result.scalar_one_or_none()
        if not file_obj:
            return None

        # Skip chunked files (no analysis data to generate from)
        if getattr(file_obj, "storage_type", None) == "chunked":
            return None

        # Skip ZK-encrypted files
        if getattr(file_obj, "encryption_mode", None) == "client_zk":
            return None

        # Only suggest for generic filenames
        if not is_generic_name(file_obj.file_name):
            return None

        # Check if user already acted on a previous suggestion
        result = await db.execute(
            select(FileNameSuggestion).filter(FileNameSuggestion.file_id == file_id)
        )
        existing = result.scalar_one_or_none()
        if existing and (existing.is_accepted or existing.is_dismissed):
            return None  # User already acted

        # Generate suggestion
        suggestion = await _generate_name_from_metadata(file_obj, db)
        if not suggestion:
            return None

        suggested_name, reason, source = suggestion

        # Upsert: update pending row or insert new
        if existing:
            existing.suggested_name = suggested_name
            existing.reason = reason
            existing.source = source
        else:
            new_suggestion = FileNameSuggestion(
                id=uuid4(),
                file_id=file_id,
                suggested_name=suggested_name,
                reason=reason,
                source=source,
            )
            db.add(new_suggestion)

        await db.commit()

        return {
            "file_id": file_id,
            "suggested_name": suggested_name,
            "reason": reason,
            "source": source,
        }

    except Exception as e:
        logger.error(f"Name suggestion failed for {file_id}: {e}")
        try:
            await db.rollback()
        except Exception:
            pass
        return None
