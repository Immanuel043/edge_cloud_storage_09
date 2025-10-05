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
from ..models.database import User, Object, FileOCR, FileMetadata, FileTag, FileHash
from ..services.ocr_service import ocr_service
from ..services.metadata_service import metadata_service
from ..services.ai_tagging_service import ai_tagging_service
from ..services.similarity_service import similarity_service
from ..services.storage import storage_service
from ..services.search_service import search_service

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

    # Load file data
    file_data = await storage_service.retrieve_file(file_obj, str(current_user.id))

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

            # Load file data
            file_data = await storage_service.retrieve_file(file_obj, user_id)

            # 1. Extract metadata
            logger.info(f"Extracting metadata for {file_id}")
            metadata = await metadata_service.extract_metadata(file_data, mime_type, filename)

            # Save metadata
            await db.execute(delete(FileMetadata).where(FileMetadata.file_id == file_id))
            await db.execute(
                insert(FileMetadata).values(
                    file_id=file_id,
                    metadata_type=metadata.get('type', 'unknown'),
                    raw_metadata=metadata,
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
            logger.info(f"Analysis complete for {file_id}")

        except Exception as e:
            logger.error(f"File analysis failed for {file_id}: {e}", exc_info=True)
            await db.rollback()
