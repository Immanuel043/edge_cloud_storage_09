"""
Document summarization service.

Pipeline: fetch OCR text → chunk if large → LLM or TF-IDF fallback → cache in file_summaries.
"""

import logging
import re
from uuid import uuid4

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..models.database import FileOCR, FileSummary, Object

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# TF-IDF extractive fallback (no LLM needed)
# ---------------------------------------------------------------------------


def _extractive_summary(text: str, num_sentences: int = 5) -> str:
    """Simple extractive summarisation using TF-IDF sentence scoring."""
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
    except ImportError:
        # scikit-learn not available — return first N sentences
        sentences = _split_sentences(text)
        return " ".join(sentences[:num_sentences])

    sentences = _split_sentences(text)
    if len(sentences) <= num_sentences:
        return " ".join(sentences)

    vectorizer = TfidfVectorizer(stop_words="english")
    tfidf_matrix = vectorizer.fit_transform(sentences)

    # Score each sentence by average TF-IDF weight
    scores = tfidf_matrix.sum(axis=1).A1  # type: ignore[union-attr]
    ranked = sorted(range(len(sentences)), key=lambda i: scores[i], reverse=True)

    # Keep top sentences in their original order
    top_indices = sorted(ranked[:num_sentences])
    return " ".join(sentences[i] for i in top_indices)


def _split_sentences(text: str) -> list[str]:
    """Split text into sentences."""
    sentences = re.split(r"(?<=[.!?])\s+", text.strip())
    return [s.strip() for s in sentences if s.strip()]


# ---------------------------------------------------------------------------
# LLM-based summarisation
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = (
    "You are a concise document summariser. "
    "Summarise the following document text in 3-5 sentences. "
    "Focus on the key topics, conclusions, and any actionable information."
)

_MAX_INPUT_CHARS = 12_000  # ~4 000 tokens at ~3 chars/token


async def _llm_summarise(text: str) -> tuple[str, str]:
    """Summarise using the configured LLM. Returns (summary, model_used)."""
    from .llm_client import llm_client

    # Truncate to fit context window
    truncated = text[:_MAX_INPUT_CHARS]
    if len(text) > _MAX_INPUT_CHARS:
        truncated += "\n\n[Text truncated for summarisation]"

    summary = await llm_client.complete(_SYSTEM_PROMPT, truncated)
    return summary, settings.LLM_MODEL


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


async def generate_summary(
    file_id: str,
    db: AsyncSession,
    *,
    force: bool = False,
) -> dict:
    """
    Generate a summary for a file synchronously.

    Returns dict with summary payload or raises ValueError for ineligible files.
    """
    # Check file exists
    result = await db.execute(select(Object).filter(Object.id == file_id))
    file_obj = result.scalar_one_or_none()
    if not file_obj:
        raise ValueError("File not found")

    # Ineligibility checks
    if getattr(file_obj, "storage_type", None) == "chunked":
        raise ValueError("INELIGIBLE: File is too large (chunked storage)")

    if getattr(file_obj, "encryption_mode", None) == "client_zk":
        raise ValueError("INELIGIBLE: Cannot summarise zero-knowledge encrypted files")

    # Check for existing cached summary (unless force regenerate)
    if not force:
        result = await db.execute(select(FileSummary).filter(FileSummary.file_id == file_id))
        existing = result.scalar_one_or_none()
        if existing:
            return _summary_to_dict(existing)

    # Get OCR text
    result = await db.execute(select(FileOCR).filter(FileOCR.file_id == file_id))
    ocr_data = result.scalar_one_or_none()
    if not ocr_data or not ocr_data.extracted_text:
        raise ValueError("INELIGIBLE: No OCR text available for this file")

    text = ocr_data.extracted_text

    # Generate summary
    model_used = "tfidf-extractive"
    try:
        if settings.LLM_ENABLED:
            from .llm_client import llm_client

            if await llm_client.is_available():
                summary_text, model_used = await _llm_summarise(text)
            else:
                summary_text = _extractive_summary(text)
        else:
            summary_text = _extractive_summary(text)
    except Exception as e:
        logger.warning(f"LLM summarisation failed for {file_id}, falling back to TF-IDF: {e}")
        summary_text = _extractive_summary(text)
        model_used = "tfidf-extractive"

    word_count = len(summary_text.split())

    # Upsert into file_summaries
    await db.execute(delete(FileSummary).where(FileSummary.file_id == file_id))
    new_summary = FileSummary(
        id=uuid4(),
        file_id=file_id,
        summary=summary_text,
        word_count=word_count,
        model_used=model_used,
    )
    db.add(new_summary)
    await db.commit()
    await db.refresh(new_summary)

    return _summary_to_dict(new_summary)


async def summarize_if_eligible(file_id: str, db: AsyncSession) -> dict | None:
    """
    Best-effort background summarisation. Returns summary dict or None.
    Called from both analysis paths (worker + router-local).
    """
    try:
        return await generate_summary(file_id, db)
    except ValueError as e:
        logger.debug(f"Summarisation skipped for {file_id}: {e}")
        return None
    except Exception as e:
        logger.error(f"Summarisation failed for {file_id}: {e}")
        return None


def _summary_to_dict(s: FileSummary) -> dict:
    return {
        "file_id": str(s.file_id),
        "summary": s.summary,
        "word_count": s.word_count,
        "model_used": s.model_used,
        "created_at": s.created_at.isoformat() if s.created_at else None,
    }
