"""
Trash Cleanup Worker - Automatically deletes files older than 30 days from trash
"""
import asyncio
import os
import sys
from datetime import datetime, timedelta
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

# Add parent directory to path to import app modules
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from models.database import Object, ActivityLog
from dependencies import get_db_session, get_redis_client


async def cleanup_old_trash_files():
    """
    Permanently delete files that have been in trash for more than 30 days
    """
    print(f"[{datetime.utcnow()}] Starting trash cleanup job...")

    db = await get_db_session()
    redis_client = await get_redis_client()

    try:
        # Calculate cutoff date (30 days ago)
        cutoff_date = datetime.utcnow() - timedelta(days=30)

        # Find files to delete
        result = await db.execute(
            select(Object).filter(
                Object.is_deleted == True,
                Object.deleted_at < cutoff_date
            )
        )
        files_to_delete = result.scalars().all()

        if not files_to_delete:
            print(f"[{datetime.utcnow()}] No files to delete. Trash cleanup complete.")
            return

        print(f"[{datetime.utcnow()}] Found {len(files_to_delete)} files to permanently delete...")

        deleted_count = 0
        freed_space = 0

        for file_obj in files_to_delete:
            try:
                # Handle content_blocks with proper reference counting
                blocks_result = await db.execute(
                    text("SELECT id, block_hash FROM content_blocks WHERE file_id = :file_id"),
                    {"file_id": str(file_obj.id)}
                )
                file_blocks = blocks_result.fetchall()

                for block in file_blocks:
                    await db.execute(
                        text("""
                            UPDATE content_blocks
                            SET reference_count = reference_count - 1
                            WHERE block_hash = :block_hash
                        """),
                        {"block_hash": block.block_hash}
                    )

                # Delete blocks that are no longer referenced
                await db.execute(
                    text("DELETE FROM content_blocks WHERE reference_count <= 0")
                )

                # Delete this file's block associations
                await db.execute(
                    text("DELETE FROM content_blocks WHERE file_id = :file_id"),
                    {"file_id": str(file_obj.id)}
                )

                # Handle different storage types - delete physical files
                if file_obj.storage_type == "inline":
                    if file_obj.storage_key:
                        try:
                            await redis_client.delete(file_obj.storage_key)
                        except Exception as e:
                            print(f"Failed to delete from Redis: {e}")

                elif file_obj.storage_type == "single":
                    if file_obj.object_path and os.path.exists(file_obj.object_path):
                        try:
                            os.remove(file_obj.object_path)
                        except Exception as e:
                            print(f"Failed to delete file: {e}")

                else:  # chunked
                    if file_obj.chunk_info:
                        chunk_info = file_obj.chunk_info
                        upload_id = chunk_info.get("upload_id", str(file_obj.id))
                        chunk_count = chunk_info.get("count", 0)
                        chunk_paths = chunk_info.get("paths", {})

                        for i in range(chunk_count):
                            chunk_path = chunk_paths.get(str(i))
                            if not chunk_path:
                                shard = upload_id[:2] if len(upload_id) >= 2 else "00"
                                chunk_path = f"/app/storage/cache/{shard}/{upload_id}_chunk_{i}.enc"

                            if os.path.exists(chunk_path):
                                try:
                                    os.remove(chunk_path)
                                except Exception as e:
                                    print(f"Failed to delete chunk: {e}")

                freed_space += file_obj.file_size

                # Delete the database record
                await db.delete(file_obj)
                deleted_count += 1

                print(f"Deleted: {file_obj.file_name} (ID: {file_obj.id}, Size: {file_obj.file_size} bytes)")

            except Exception as e:
                print(f"Failed to delete file {file_obj.id}: {e}")
                continue

        # Log the cleanup activity
        activity = ActivityLog(
            user_id=None,  # System activity
            action="trash_auto_cleanup",
            object_id=None,
            ip_address="127.0.0.1",
            user_agent="trash_cleanup_worker",
            meta_data={
                "deleted_count": deleted_count,
                "freed_space": freed_space,
                "cutoff_date": cutoff_date.isoformat()
            }
        )
        db.add(activity)

        await db.commit()

        print(f"[{datetime.utcnow()}] Trash cleanup complete!")
        print(f"  - Files deleted: {deleted_count}")
        print(f"  - Space freed: {freed_space / (1024*1024):.2f} MB")

    except Exception as e:
        await db.rollback()
        print(f"[{datetime.utcnow()}] Error during trash cleanup: {e}")
        import traceback
        traceback.print_exc()
    finally:
        await db.close()


async def main():
    """Main entry point for the worker"""
    await cleanup_old_trash_files()


if __name__ == "__main__":
    # Run the cleanup job
    asyncio.run(main())
