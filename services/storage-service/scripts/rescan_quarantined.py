"""One-off rescan for fail-closed quarantined files.

Selects rows whose quarantine_reason is one of the bypass-class strings the
upload pipeline emits, re-runs the appropriate scan path against the now-
healthy ClamAV, and clears the quarantine flags only on a definitively clean
verdict. Files larger than MAX_INSTREAM_BYTES are reported as skipped — they
remain quarantined until the cap is raised.

Usage:
    docker compose exec -T storage-service python -m scripts.rescan_quarantined
"""

from __future__ import annotations

import asyncio
import base64
import logging
import os
from typing import Optional

from sqlalchemy import select, update

from app.config import settings
from app.database import async_session
from app.models.database import Object
from app.services.encryption import encryption_service
from app.services.scan_streaming import iter_decrypted_chunks
from app.services.virus_scanner import VirusScanResult, get_virus_scanner
from app.utils.compression import decompressor

import aiofiles

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("rescan_quarantined")

# Quarantine reasons that the script should consider for rescan. These match
# the strings written by app/routers/upload.py in the paid-tier fail-closed
# branch. New bypass reasons must be added here.
RESCANNABLE_REASON_PATTERNS = (
    "Virus scanner unavailable%",
    "File exceeds maximum scan size%",
)


def _needs_decompress(file_obj: Object) -> bool:
    return (
        isinstance(file_obj.file_metadata, dict)
        and bool(file_obj.file_metadata.get("compressed"))
    )


_ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"


async def _iter_cas_blocks(file_obj):
    """Yield decrypted plaintext bytes per CAS block, in original order.

    Mirrors the convergent-decrypt path in `app/routers/files.py` (lines 405-505).
    Only convergent_encryption=True is supported here — that's the path the
    deduplication pipeline uses, and it's what produced the rows we're rescanning.
    """
    import hashlib
    from cryptography.hazmat.backends import default_backend
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes

    chunk_info = file_obj.chunk_info or {}
    blocks = chunk_info.get("blocks") or []
    stored_blocks = chunk_info.get("stored_blocks") or []
    if not blocks or not stored_blocks:
        raise ValueError(f"CAS file {file_obj.id} missing blocks/stored_blocks")
    if not chunk_info.get("convergent_encryption", False):
        raise ValueError(
            f"CAS file {file_obj.id} is not convergent_encryption — rescan unsupported"
        )

    user_id = str(file_obj.user_id)
    salt = hashlib.sha256(f"dedup_user_{user_id}_salt".encode()).digest()
    block_map = {b["hash"]: b for b in stored_blocks}

    for block in blocks:
        block_hash = block["hash"]
        block_size = block["size"]
        stored = block_map.get(block_hash)
        if not stored:
            raise FileNotFoundError(f"Block {block_hash[:8]} not in stored_blocks")
        block_path = stored["path"]
        if not os.path.exists(block_path):
            raise FileNotFoundError(f"Block file missing: {block_path}")

        async with aiofiles.open(block_path, "rb") as f:
            encrypted = await f.read()

        # Per-block convergent key: PBKDF2(content_hash, dedup_user_<id>_salt, 100k)
        content_hash_bytes = bytes.fromhex(block_hash)
        block_key = hashlib.pbkdf2_hmac(
            "sha256", content_hash_bytes, salt, 100000, dklen=32
        )
        nonce = encrypted[:12]
        tag = encrypted[12:28]
        ciphertext = encrypted[28:]
        cipher = Cipher(
            algorithms.AES(block_key),
            modes.GCM(nonce, tag),
            backend=default_backend(),
        )
        decryptor_obj = cipher.decryptor()
        plaintext = decryptor_obj.update(ciphertext) + decryptor_obj.finalize()

        was_compressed = stored.get("was_compressed", False)
        if was_compressed:
            plaintext = decompressor.decompress(plaintext, max_output_size=64 * 1024 * 1024)
        elif (
            len(plaintext) >= 4
            and plaintext[:4] == _ZSTD_MAGIC
            and len(plaintext) != block_size
        ):
            # Safety net: was_compressed flag can lie on older CAS blocks (Fix 21).
            plaintext = decompressor.decompress(plaintext, max_output_size=64 * 1024 * 1024)

        yield plaintext


async def _scan_one(
    file_obj: Object, scanner, file_key: bytes
) -> Optional[VirusScanResult]:
    """Dispatch to the right scan path. Returns None if storage_type unsupported."""
    storage_type = file_obj.storage_type

    if storage_type == "inline":
        encrypted_data = base64.b64decode(file_obj.storage_key)
        plaintext = encryption_service.decrypt_data(encrypted_data, file_key)
        if _needs_decompress(file_obj):
            plaintext = decompressor.decompress(plaintext)
        return await scanner.scan_bytes(plaintext)

    if storage_type == "single":
        if not file_obj.object_path or not os.path.exists(file_obj.object_path):
            logger.warning(
                "single-storage file %s missing object_path %s; cannot rescan",
                file_obj.id, file_obj.object_path,
            )
            return None
        with open(file_obj.object_path, "rb") as f:
            encrypted_data = f.read()
        plaintext = encryption_service.decrypt_data(encrypted_data, file_key)
        if _needs_decompress(file_obj):
            plaintext = decompressor.decompress(plaintext)
        return await scanner.scan_bytes(plaintext)

    if storage_type == "chunked":
        return await scanner.scan_stream(
            iter_decrypted_chunks(file_obj, file_key),
            total_size=file_obj.file_size,
        )

    if storage_type == "content_addressed":
        return await scanner.scan_stream(
            _iter_cas_blocks(file_obj),
            total_size=file_obj.file_size,
        )

    logger.warning("Unsupported storage_type %r for %s; skipping", storage_type, file_obj.id)
    return None


async def main() -> int:
    scanner = get_virus_scanner()
    if not await scanner.ping():
        logger.error("ClamAV ping failed — refusing to run rescan against an unreachable scanner")
        return 1

    cleared = 0
    still_quarantined = 0
    skipped_too_large = 0
    errored = 0

    async with async_session() as db:
        # Build OR of ILIKE patterns rather than relying on PG-specific operators.
        from sqlalchemy import or_
        rescan_filter = or_(
            *(Object.quarantine_reason.ilike(p) for p in RESCANNABLE_REASON_PATTERNS)
        )
        stmt = select(Object).where(Object.is_quarantined.is_(True), rescan_filter)
        rows = (await db.execute(stmt)).scalars().all()

    logger.info("Found %d quarantined file(s) eligible for rescan", len(rows))
    if not rows:
        return 0

    for file_obj in rows:
        label = f"{file_obj.id} ({file_obj.file_name!r}, {file_obj.file_size} bytes, {file_obj.storage_type})"
        # Pre-skip oversized files so we don't open a clamd connection just to
        # short-circuit. scan_stream would emit the same verdict, but skipping
        # here keeps the summary counter clean.
        if (
            file_obj.storage_type in ("chunked", "content_addressed")
            and file_obj.file_size is not None
            and file_obj.file_size > settings.MAX_INSTREAM_BYTES
        ):
            logger.info(
                "skipping %s — exceeds MAX_INSTREAM_BYTES (%d)",
                label, settings.MAX_INSTREAM_BYTES,
            )
            skipped_too_large += 1
            continue

        try:
            # Convergent CAS files have no per-file key; the per-block key is
            # derived from the block's content hash + user salt. Skip the
            # file-key unwrap for that path.
            if file_obj.storage_type == "content_addressed":
                file_key = b""
            else:
                file_key = encryption_service.decrypt_key(file_obj.encryption_key)
            result = await _scan_one(file_obj, scanner, file_key)
        except Exception as e:
            logger.exception("rescan errored for %s: %s", label, e)
            errored += 1
            continue

        if result is None:
            errored += 1
            continue

        if result.scan_status == VirusScanResult.STATUS_CLEAN:
            async with async_session() as db:
                await db.execute(
                    update(Object)
                    .where(Object.id == file_obj.id)
                    .values(
                        is_quarantined=False,
                        quarantined_at=None,
                        quarantine_reason=None,
                    )
                )
                await db.commit()
            logger.info("CLEARED %s (scan_time=%.2fs)", label, result.scan_time)
            cleared += 1
        elif result.scan_status == VirusScanResult.STATUS_INFECTED:
            logger.warning(
                "INFECTED %s — virus_name=%s; leaving quarantined",
                label, result.virus_name,
            )
            still_quarantined += 1
        else:
            logger.warning(
                "BYPASSED %s — scanner could not produce a verdict (error=%s); leaving quarantined",
                label, result.error,
            )
            still_quarantined += 1

    print(
        f"\nSummary: cleared={cleared}, "
        f"still_quarantined={still_quarantined}, "
        f"skipped_too_large={skipped_too_large}, "
        f"errored={errored}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
