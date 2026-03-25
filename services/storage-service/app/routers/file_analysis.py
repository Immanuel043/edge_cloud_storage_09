"""
File Analysis API Router
Endpoints for OCR, metadata extraction, and AI tagging
"""
from fastapi import APIRouter, Depends, HTTPException, BackgroundTasks
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, insert, delete
from typing import List, Optional
import logging

from ..dependencies import get_current_user, get_db
from ..models.database import (
    User, Object, FileOCR, FileMetadata, FileTag, FileHash,
    FileSummary, FileNameSuggestion,
)
from ..services.ocr_service import ocr_service
from ..services.metadata_service import metadata_service
from ..services.ai_tagging_service import ai_tagging_service
from ..services.similarity_service import similarity_service
from ..services.storage import storage_service
from ..services.search_service import search_service
from ..services.summarization_service import generate_summary, summarize_if_eligible
from ..services.encryption import encryption_service

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/files", tags=["file-analysis"])


# ============================================================================
# OCR Endpoints
# ============================================================================

@router.post("/{file_id}/analyze")
async def analyze_file(
    file_id: str,
    background_tasks: BackgroundTasks,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """
    Trigger complete file analysis (OCR + metadata + hashing + AI tags)
    Runs in background
    """
    # Verify file ownership
    result = await db.execute(
        select(Object).filter(
            Object.id == file_id,
            Object.user_id == current_user.id
        )
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Queue background analysis
    background_tasks.add_task(
        process_file_analysis,
        file_id=file_id,
        user_id=str(current_user.id),
        mime_type=file_obj.mime_type,
        filename=file_obj.file_name
    )

    return {
        "success": True,
        "message": "File analysis started",
        "file_id": file_id
    }


@router.get("/{file_id}/ocr")
async def get_file_ocr(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get OCR extracted text for a file"""
    # Verify file ownership
    result = await db.execute(
        select(Object).filter(
            Object.id == file_id,
            Object.user_id == current_user.id
        )
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Get OCR data
    result = await db.execute(
        select(FileOCR).filter(FileOCR.file_id == file_id)
    )
    ocr_data = result.scalar_one_or_none()

    if not ocr_data:
        raise HTTPException(status_code=404, detail="OCR data not found. Run analysis first.")

    return {
        "file_id": file_id,
        "extracted_text": ocr_data.extracted_text,
        "word_count": ocr_data.word_count,
        "confidence": ocr_data.confidence,
        "ocr_engine": ocr_data.ocr_engine,
        "languages": ocr_data.languages,
        "page_count": ocr_data.page_count,
        "extraction_method": ocr_data.extraction_method,
        "created_at": ocr_data.created_at
    }


@router.post("/{file_id}/ocr/extract")
async def extract_ocr_now(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Force OCR extraction immediately (synchronous)"""
    # Verify file ownership
    result = await db.execute(
        select(Object).filter(
            Object.id == file_id,
            Object.user_id == current_user.id
        )
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Check if file type supports OCR
    if not (file_obj.mime_type.startswith('image/') or file_obj.mime_type == 'application/pdf'):
        raise HTTPException(status_code=400, detail="File type does not support OCR")

    # Decrypt file key and load file data
    file_key = encryption_service.decrypt_key(file_obj.encryption_key)
    file_data = await storage_service.retrieve_file(file_obj, decrypt_key=file_key)

    # Extract text
    ocr_result = await ocr_service.extract_text(file_data, file_obj.mime_type)

    if not ocr_result['success']:
        raise HTTPException(status_code=500, detail=f"OCR failed: {ocr_result.get('error')}")

    # Save to database
    await db.execute(
        delete(FileOCR).where(FileOCR.file_id == file_id)
    )

    await db.execute(
        insert(FileOCR).values(
            file_id=file_id,
            extracted_text=ocr_result['text'],
            word_count=ocr_result.get('word_count', 0),
            confidence=int(ocr_result.get('confidence', 0)),
            ocr_engine=ocr_result.get('engine', 'tesseract'),
            languages=ocr_result.get('languages', ['eng']),
            page_count=ocr_result.get('page_count', 1),
            extraction_method=ocr_result.get('method', 'ocr')
        )
    )

    await db.commit()

    # Index in Elasticsearch
    try:
        await search_service.update_file_text(file_id, ocr_result['text'])
    except Exception as e:
        logger.error(f"Failed to index OCR text: {e}")

    return {
        "success": True,
        "file_id": file_id,
        "text": ocr_result['text'],
        "word_count": ocr_result.get('word_count', 0),
        "confidence": ocr_result.get('confidence', 0)
    }


# ============================================================================
# Metadata Endpoints
# ============================================================================

@router.get("/{file_id}/metadata")
async def get_file_metadata(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get extended metadata for a file"""
    # Verify file ownership
    result = await db.execute(
        select(Object).filter(
            Object.id == file_id,
            Object.user_id == current_user.id
        )
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Get metadata
    result = await db.execute(
        select(FileMetadata).filter(FileMetadata.file_id == file_id)
    )
    metadata = result.scalar_one_or_none()

    if not metadata:
        raise HTTPException(status_code=404, detail="Metadata not found. Run analysis first.")

    return {
        "file_id": file_id,
        "type": metadata.metadata_type,
        "raw_metadata": metadata.raw_metadata,
        "width": metadata.width,
        "height": metadata.height,
        "duration": metadata.duration,
        "page_count": metadata.page_count,
        "camera_make": metadata.camera_make,
        "camera_model": metadata.camera_model,
        "date_taken": metadata.date_taken,
        "gps_latitude": metadata.gps_latitude,
        "gps_longitude": metadata.gps_longitude,
        "artist": metadata.artist,
        "album": metadata.album,
        "title": metadata.title,
        "genre": metadata.genre,
        "bitrate": metadata.bitrate,
        "author": metadata.author,
        "word_count": metadata.word_count,
        "created_at": metadata.created_at
    }


# ============================================================================
# Tags Endpoints
# ============================================================================

@router.get("/{file_id}/tags")
async def get_file_tags(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get all tags for a file"""
    # Verify file ownership
    result = await db.execute(
        select(Object).filter(
            Object.id == file_id,
            Object.user_id == current_user.id
        )
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Get tags
    result = await db.execute(
        select(FileTag).filter(FileTag.file_id == file_id).order_by(FileTag.confidence.desc())
    )
    tags = result.scalars().all()

    return {
        "file_id": file_id,
        "tags": [
            {
                "tag": tag.tag,
                "confidence": tag.confidence,
                "source": tag.source,
                "created_at": tag.created_at
            }
            for tag in tags
        ]
    }


@router.post("/{file_id}/tags")
async def add_file_tag(
    file_id: str,
    tag: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Add a manual tag to a file"""
    # Verify file ownership
    result = await db.execute(
        select(Object).filter(
            Object.id == file_id,
            Object.user_id == current_user.id
        )
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Add tag (ignore if exists due to unique constraint)
    try:
        await db.execute(
            insert(FileTag).values(
                file_id=file_id,
                tag=tag.lower().strip(),
                confidence=100,
                source='manual',
                created_by=current_user.id
            )
        )
        await db.commit()
    except Exception as e:
        if "unique" in str(e).lower():
            raise HTTPException(status_code=400, detail="Tag already exists")
        raise

    return {
        "success": True,
        "file_id": file_id,
        "tag": tag
    }


@router.delete("/{file_id}/tags/{tag}")
async def remove_file_tag(
    file_id: str,
    tag: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Remove a tag from a file"""
    # Verify file ownership
    result = await db.execute(
        select(Object).filter(
            Object.id == file_id,
            Object.user_id == current_user.id
        )
    )
    file_obj = result.scalar_one_or_none()

    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    # Delete tag
    await db.execute(
        delete(FileTag).where(
            FileTag.file_id == file_id,
            FileTag.tag == tag.lower().strip()
        )
    )
    await db.commit()

    return {
        "success": True,
        "file_id": file_id,
        "tag": tag
    }


@router.get("/search/tags/{tag}")
async def search_by_tag(
    tag: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Find all files with a specific tag"""
    result = await db.execute(
        select(Object, FileTag).join(
            FileTag, Object.id == FileTag.file_id
        ).filter(
            Object.user_id == current_user.id,
            FileTag.tag == tag.lower().strip()
        )
    )

    files = []
    for file_obj, file_tag in result.all():
        files.append({
            "id": str(file_obj.id),
            "name": file_obj.file_name,
            "size": file_obj.file_size,
            "mime_type": file_obj.mime_type,
            "tag_confidence": file_tag.confidence,
            "tag_source": file_tag.source,
            "created_at": file_obj.created_at
        })

    return {
        "tag": tag,
        "count": len(files),
        "files": files
    }


# ============================================================================
# Summary Endpoints
# ============================================================================

@router.get("/{file_id}/summary")
async def get_file_summary(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get cached document summary for a file"""
    # Verify ownership
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="File not found")

    result = await db.execute(
        select(FileSummary).filter(FileSummary.file_id == file_id)
    )
    summary = result.scalar_one_or_none()
    if not summary:
        raise HTTPException(status_code=404, detail="Summary not found. Generate one first.")

    return {
        "file_id": file_id,
        "summary": summary.summary,
        "word_count": summary.word_count,
        "model_used": summary.model_used,
        "created_at": summary.created_at,
    }


@router.post("/{file_id}/summary/generate")
async def generate_file_summary(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Generate a document summary (synchronous). Returns 409 for ineligible files."""
    # Verify ownership
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="File not found")

    try:
        payload = await generate_summary(file_id, db)
        return payload
    except ValueError as e:
        msg = str(e)
        if msg.startswith("INELIGIBLE:"):
            raise HTTPException(status_code=409, detail=msg.replace("INELIGIBLE: ", ""))
        raise HTTPException(status_code=400, detail=msg)


@router.post("/{file_id}/summary/regenerate")
async def regenerate_file_summary(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete cached summary and regenerate"""
    # Verify ownership
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="File not found")

    try:
        payload = await generate_summary(file_id, db, force=True)
        return payload
    except ValueError as e:
        msg = str(e)
        if msg.startswith("INELIGIBLE:"):
            raise HTTPException(status_code=409, detail=msg.replace("INELIGIBLE: ", ""))
        raise HTTPException(status_code=400, detail=msg)


# ============================================================================
# Name Suggestion Endpoints
# ============================================================================

@router.get("/{file_id}/name-suggestion")
async def get_name_suggestion(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get AI-generated name suggestion for a file"""
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="File not found")

    result = await db.execute(
        select(FileNameSuggestion).filter(
            FileNameSuggestion.file_id == file_id,
            FileNameSuggestion.is_accepted == False,
            FileNameSuggestion.is_dismissed == False,
        )
    )
    suggestion = result.scalar_one_or_none()
    if not suggestion:
        raise HTTPException(status_code=404, detail="No name suggestion available")

    return {
        "file_id": file_id,
        "suggested_name": suggestion.suggested_name,
        "reason": suggestion.reason,
        "source": suggestion.source,
        "created_at": suggestion.created_at,
    }


@router.post("/{file_id}/name-suggestion/accept")
async def accept_name_suggestion(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Accept a name suggestion — performs the rename server-side"""
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    file_obj = result.scalar_one_or_none()
    if not file_obj:
        raise HTTPException(status_code=404, detail="File not found")

    result = await db.execute(
        select(FileNameSuggestion).filter(
            FileNameSuggestion.file_id == file_id,
            FileNameSuggestion.is_accepted == False,
            FileNameSuggestion.is_dismissed == False,
        )
    )
    suggestion = result.scalar_one_or_none()
    if not suggestion:
        raise HTTPException(status_code=404, detail="No pending name suggestion")

    # Use the shared rename helper from files.py
    from .files import perform_rename
    file_obj = await perform_rename(
        file_obj, suggestion.suggested_name, current_user.id, db
    )

    # perform_rename already marks suggestion as accepted via stale-suggestion cleanup
    return {
        "success": True,
        "file_id": file_id,
        "new_name": file_obj.file_name,
    }


@router.post("/{file_id}/name-suggestion/dismiss")
async def dismiss_name_suggestion(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Dismiss a name suggestion"""
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="File not found")

    result = await db.execute(
        select(FileNameSuggestion).filter(
            FileNameSuggestion.file_id == file_id,
            FileNameSuggestion.is_accepted == False,
            FileNameSuggestion.is_dismissed == False,
        )
    )
    suggestion = result.scalar_one_or_none()
    if not suggestion:
        raise HTTPException(status_code=404, detail="No pending name suggestion")

    suggestion.is_dismissed = True
    await db.commit()

    return {"success": True, "file_id": file_id}


# ============================================================================
# Analysis Status & Pending Suggestions Endpoints
# ============================================================================

@router.get("/{file_id}/analysis-status")
async def get_analysis_status(
    file_id: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get analysis completion status from Redis. Used for post-upload polling."""
    result = await db.execute(
        select(Object).filter(Object.id == file_id, Object.user_id == current_user.id)
    )
    if not result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="File not found")

    try:
        import json
        from ..database import redis_client
        if redis_client:
            data = await redis_client.get(f"analysis:status:{file_id}")
            if data:
                status_info = json.loads(data)
                status = status_info.get("status", "unknown")

                if status == "skipped":
                    return {"status": "skipped", "has_suggestion": False}

                if status == "completed":
                    # Check for pending name suggestion in DB
                    ns_result = await db.execute(
                        select(FileNameSuggestion).filter(
                            FileNameSuggestion.file_id == file_id,
                            FileNameSuggestion.is_accepted == False,
                            FileNameSuggestion.is_dismissed == False,
                        )
                    )
                    has_suggestion = ns_result.scalar_one_or_none() is not None
                    return {"status": "completed", "has_suggestion": has_suggestion}
    except Exception as e:
        logger.warning(f"Failed to read analysis status for {file_id}: {e}")

    return {"status": "unknown"}


@router.get("/pending-suggestions/batch")
async def get_pending_suggestions(
    file_ids: str,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Batch check which files have pending name suggestions.
    Query param file_ids: comma-separated file IDs.
    """
    ids = [fid.strip() for fid in file_ids.split(",") if fid.strip()]
    if not ids:
        return {"suggestions": {}}

    # Verify ownership and get pending suggestions in one query
    from sqlalchemy import and_
    result = await db.execute(
        select(FileNameSuggestion, Object)
        .join(Object, FileNameSuggestion.file_id == Object.id)
        .filter(
            Object.user_id == current_user.id,
            FileNameSuggestion.file_id.in_(ids),
            FileNameSuggestion.is_accepted == False,
            FileNameSuggestion.is_dismissed == False,
        )
    )

    suggestions = {}
    for suggestion, file_obj in result.all():
        suggestions[str(suggestion.file_id)] = {
            "suggested_name": suggestion.suggested_name,
            "reason": suggestion.reason,
        }

    return {"suggestions": suggestions}


# ============================================================================
# Background Processing
# ============================================================================

async def process_file_analysis(file_id: str, user_id: str, mime_type: str, filename: str):
    """Background task to process file analysis"""
    from ..database import async_session

    async with async_session() as db:
        try:
            # Get file object
            result = await db.execute(
                select(Object).filter(Object.id == file_id)
            )
            file_obj = result.scalar_one_or_none()

            if not file_obj:
                logger.error(f"File {file_id} not found for analysis")
                return

            # Skip chunked files — too large to load into memory (matches worker line 223)
            if getattr(file_obj, "storage_type", None) == "chunked":
                # Write terminal Redis status so frontend polling stops immediately
                try:
                    import json
                    from datetime import datetime, timezone
                    from ..database import redis_client
                    if redis_client:
                        status_data = json.dumps({
                            "status": "skipped",
                            "reason": "chunked",
                            "completed_at": datetime.now(timezone.utc).isoformat(),
                        })
                        await redis_client.setex(
                            f"analysis:status:{file_id}", 86400, status_data
                        )
                except Exception as e:
                    logger.warning(f"Failed to write skipped Redis status for {file_id}: {e}")
                logger.info(f"Skipping analysis for chunked file {file_id}")
                return

            # Decrypt file key and load file data
            file_key = encryption_service.decrypt_key(file_obj.encryption_key)
            if file_obj.storage_type == "inline" and file_obj.storage_key and len(file_obj.storage_key) > 200:
                # Inline files: encrypted data is base64-encoded in storage_key column
                import base64
                encrypted_data = base64.b64decode(file_obj.storage_key)
                file_data = encryption_service.decrypt_file(encrypted_data, file_key)
                # Handle compression
                if file_obj.file_metadata and isinstance(file_obj.file_metadata, dict) and file_obj.file_metadata.get("compressed", False):
                    from ..utils.compression import compressor
                    file_data = compressor.decompress(file_data)
            else:
                file_data = await storage_service.retrieve_file(file_obj, decrypt_key=file_key)

            # 1. Extract metadata
            logger.info(f"Extracting metadata for {file_id}")
            metadata = await metadata_service.extract_metadata(file_data, mime_type, filename)

            # Save metadata (sanitize null bytes that break PostgreSQL JSONB)
            import json as _json
            sanitized_metadata = _json.loads(_json.dumps(metadata).replace('\\u0000', ''))
            await db.execute(delete(FileMetadata).where(FileMetadata.file_id == file_id))
            await db.execute(
                insert(FileMetadata).values(
                    file_id=file_id,
                    metadata_type=metadata.get('type', 'unknown'),
                    raw_metadata=sanitized_metadata,
                    width=metadata.get('width'),
                    height=metadata.get('height'),
                    duration=metadata.get('duration'),
                    page_count=metadata.get('page_count'),
                    camera_make=metadata.get('camera_make'),
                    camera_model=metadata.get('camera_model'),
                    date_taken=metadata.get('date_taken'),
                    artist=metadata.get('artist'),
                    album=metadata.get('album'),
                    title=metadata.get('title'),
                    genre=metadata.get('genre'),
                    bitrate=metadata.get('bitrate'),
                    author=metadata.get('author'),
                    word_count=metadata.get('word_count')
                )
            )

            # 2. OCR if applicable
            ocr_text = None
            if mime_type.startswith('image/') or mime_type == 'application/pdf':
                logger.info(f"Extracting OCR for {file_id}")
                ocr_result = await ocr_service.extract_text(file_data, mime_type)

                if ocr_result['success']:
                    ocr_text = ocr_result['text']

                    await db.execute(delete(FileOCR).where(FileOCR.file_id == file_id))
                    await db.execute(
                        insert(FileOCR).values(
                            file_id=file_id,
                            extracted_text=ocr_text,
                            word_count=ocr_result.get('word_count', 0),
                            confidence=int(ocr_result.get('confidence', 0)),
                            ocr_engine=ocr_result.get('engine', 'tesseract'),
                            languages=ocr_result.get('languages', ['eng']),
                            page_count=ocr_result.get('page_count', 1),
                            extraction_method=ocr_result.get('method', 'ocr')
                        )
                    )

                    # Index in Elasticsearch
                    try:
                        await search_service.update_file_text(file_id, ocr_text)
                    except Exception as e:
                        logger.error(f"Failed to index OCR: {e}")

            # 3. Compute perceptual hashes (for images)
            if mime_type.startswith('image/'):
                logger.info(f"Computing hashes for {file_id}")
                hashes = await similarity_service.compute_image_hashes(file_data)

                if hashes.get('success'):
                    await db.execute(delete(FileHash).where(FileHash.file_id == file_id))
                    await db.execute(
                        insert(FileHash).values(
                            file_id=file_id,
                            phash=hashes.get('phash'),
                            dhash=hashes.get('dhash'),
                            whash=hashes.get('whash'),
                            average_hash=hashes.get('average_hash'),
                            colorhash=hashes.get('colorhash')
                        )
                    )

            # 4. Generate AI tags
            logger.info(f"Generating tags for {file_id}")
            tags = await ai_tagging_service.generate_smart_tags(
                file_data, mime_type, filename,
                extracted_text=ocr_text,
                metadata=metadata
            )

            # Save tags
            await db.execute(delete(FileTag).where(FileTag.file_id == file_id, FileTag.source != 'manual'))
            for tag_data in tags:
                try:
                    await db.execute(
                        insert(FileTag).values(
                            file_id=file_id,
                            tag=tag_data['tag'],
                            confidence=int(tag_data['confidence']),
                            source=tag_data['source']
                        )
                    )
                except:
                    pass  # Ignore duplicates

            await db.commit()

            # 5. Summarization (best-effort, after OCR)
            try:
                await summarize_if_eligible(file_id, db)
            except Exception as e:
                logger.warning(f"Summarization failed for {file_id}: {e}")

            # 6. Smart naming (best-effort) — added in Feature 2
            try:
                from ..services.file_naming_service import suggest_name_if_eligible
                await suggest_name_if_eligible(file_id, db)
            except ImportError:
                pass  # Feature 2 not yet implemented
            except Exception as e:
                logger.warning(f"Name suggestion failed for {file_id}: {e}")

            # Write Redis analysis status (mirrors worker line 345)
            try:
                import json
                from datetime import datetime, timezone
                from ..database import redis_client
                if redis_client:
                    # Check for name suggestion
                    ns_result = await db.execute(
                        select(FileNameSuggestion).filter(
                            FileNameSuggestion.file_id == file_id,
                            FileNameSuggestion.is_accepted == False,
                            FileNameSuggestion.is_dismissed == False,
                        )
                    )
                    has_suggestion = ns_result.scalar_one_or_none() is not None

                    status_data = json.dumps({
                        "status": "completed",
                        "completed_at": datetime.now(timezone.utc).isoformat(),
                        "has_ocr": ocr_text is not None,
                        "has_metadata": True,
                        "tag_count": len(tags),
                        "has_suggestion": has_suggestion,
                    })
                    await redis_client.setex(
                        f"analysis:status:{file_id}", 86400, status_data
                    )
            except Exception as e:
                logger.warning(f"Failed to write Redis status for {file_id}: {e}")

            logger.info(f"Analysis complete for {file_id}")

        except Exception as e:
            logger.error(f"File analysis failed for {file_id}: {e}", exc_info=True)
            await db.rollback()
