"""
Dedup Promotion Utilities

Shared module for dedup-aware permanent deletion:
- promote_dedup_references: promotes a reference to owner when deleting a storage-owning file
- decrement_dedup_ref_counts: decrements block ref counts when deleting a deduplicated_reference

Uses raw SQL only (no ORM model imports) so it works from both FastAPI app and standalone workers.
"""
import json
import logging
from sqlalchemy import text

logger = logging.getLogger(__name__)


async def promote_dedup_references(file_obj, db, exclude_ids=None) -> bool:
    """
    Called when permanently deleting a storage-owning file.
    Promotes an eligible reference to become the new owner of the backing storage.

    Args:
        file_obj: The file object being deleted (must have .id, .storage_type, .dedup_info)
        db: AsyncSession
        exclude_ids: Set of file ID strings to exclude from promotion eligibility
                     (e.g. other files in the same batch being deleted).
                     Excluded files are still re-pointed but cannot be the promotion target.

    Returns:
        True if a reference was promoted (caller should skip storage cleanup),
        False otherwise (caller should proceed with normal cleanup).
    """
    if exclude_ids is None:
        exclude_ids = set()

    # Only storage-owning types need promotion
    if file_obj.storage_type not in ('content_addressed', 'chunked'):
        return False

    file_id = str(file_obj.id)
    user_id = str(file_obj.user_id)

    # 1. Query ALL refs pointing to this file (any user, active + trashed)
    refs_result = await db.execute(
        text("""
            SELECT id, is_deleted, user_id
            FROM objects
            WHERE storage_type = 'deduplicated_reference'
              AND dedup_info->>'reference_file_id' = :file_id
            ORDER BY is_deleted ASC
        """),
        {"file_id": file_id}
    )
    refs = refs_result.fetchall()

    if not refs:
        return False

    # 2. Split into lists
    all_ref_ids = [str(r.id) for r in refs]
    eligible_ids = [
        str(r.id) for r in refs
        if str(r.user_id) == user_id and str(r.id) not in exclude_ids
    ]

    # 3. If no eligible same-user ref can be promoted, return False
    #    Cross-user refs are left for Fix 12 (graceful 404)
    if not eligible_ids:
        logger.info(
            f"No eligible promotion target for file {file_id}. "
            f"{len(all_ref_ids)} cross-user/excluded refs will dangle."
        )
        return False

    # 4. Pick the first eligible ref (active preferred via ORDER BY is_deleted ASC)
    promoted_id = eligible_ids[0]

    # 5. Copy storage fields to promoted file
    dedup_info_update = {
        "promoted_from": file_id,
    }
    await db.execute(
        text("""
            UPDATE objects SET
                storage_type = :storage_type,
                chunk_info = :chunk_info,
                encryption_key = :encryption_key,
                object_path = :object_path,
                storage_key = :storage_key,
                dedup_info = :dedup_info
            WHERE id = :promoted_id
        """),
        {
            "storage_type": file_obj.storage_type,
            "chunk_info": json.dumps(file_obj.chunk_info) if file_obj.chunk_info else None,
            "encryption_key": file_obj.encryption_key,
            "object_path": file_obj.object_path,
            "storage_key": file_obj.storage_key,
            "dedup_info": json.dumps(dedup_info_update),
            "promoted_id": promoted_id,
        }
    )

    # 6. Re-assign block ownership
    await db.execute(
        text("UPDATE content_blocks SET file_id = :promoted_id WHERE file_id = :old_id"),
        {"promoted_id": promoted_id, "old_id": file_id}
    )

    # 7. Decrement reference_count by 1 for transferred blocks
    #    (The deleted original was one logical user of these blocks)
    await db.execute(
        text("""
            UPDATE content_blocks
            SET reference_count = reference_count - 1
            WHERE file_id = :promoted_id
        """),
        {"promoted_id": promoted_id}
    )

    # 8. Re-point ALL other refs to promoted file (including excluded + cross-user)
    other_ref_ids = [rid for rid in all_ref_ids if rid != promoted_id]
    cross_user_ref_ids = [str(r.id) for r in refs if str(r.user_id) != user_id]

    if other_ref_ids:
        await db.execute(
            text("""
                UPDATE objects
                SET dedup_info = jsonb_set(
                    COALESCE(dedup_info::jsonb, '{}'::jsonb),
                    '{reference_file_id}',
                    to_jsonb(:promoted_id::text)
                )
                WHERE id = ANY(:ref_ids)
            """),
            {"promoted_id": promoted_id, "ref_ids": other_ref_ids}
        )

    # 9. Log
    msg = f"Promoted dedup reference {promoted_id} to owner (was {file_id}). Re-pointed {len(other_ref_ids)} other refs."
    if cross_user_ref_ids:
        cross_user_ids = list({str(r.user_id) for r in refs if str(r.user_id) != user_id})
        msg += f" Cross-user refs re-pointed for user_ids: {cross_user_ids}"
    logger.info(msg)

    # 10.
    return True


async def decrement_dedup_ref_counts(file_obj, db) -> None:
    """
    Called when permanently deleting a deduplicated_reference file.
    Decrements block reference counts on the original owner's blocks.

    Reads reference_file_id from the DB (not in-memory) because
    promote_dedup_references may have re-pointed it in the same transaction.

    Works correctly across all scenarios:
    - Normal: reference_file_id points to active owner -> blocks found, decremented
    - After promotion: reference_file_id was re-pointed -> blocks at new owner, decremented
    - Dangling (owner deleted, no promotion): WHERE file_id = old_owner -> no rows -> no-op
    """
    if file_obj.storage_type != 'deduplicated_reference':
        return

    # Read current dedup_info from DB — may have been re-pointed by promote_dedup_references
    result = await db.execute(
        text("SELECT dedup_info FROM objects WHERE id = :file_id"),
        {"file_id": str(file_obj.id)}
    )
    row = result.fetchone()
    if not row or not row.dedup_info:
        return

    dedup_info = row.dedup_info if isinstance(row.dedup_info, dict) else json.loads(row.dedup_info)
    reference_file_id = dedup_info.get('reference_file_id')
    if not reference_file_id:
        return

    await db.execute(
        text("""
            UPDATE content_blocks
            SET reference_count = reference_count - 1
            WHERE file_id = :reference_file_id
        """),
        {"reference_file_id": reference_file_id}
    )
