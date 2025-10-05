"""
Migration script to index all existing files and folders in Elasticsearch
"""
import asyncio
import sys
from pathlib import Path

# Add parent directory to path
sys.path.append(str(Path(__file__).parent.parent))

from sqlalchemy import select
from app.database import async_session
from app.models.database import Object, Folder
from app.services.search_service import search_service


async def index_all_files():
    """Index all existing files in the database"""
    async with async_session() as session:
        # Get all files (stored in objects table)
        result = await session.execute(select(Object))
        files = result.scalars().all()

        print(f"Found {len(files)} files to index")

        indexed = 0
        failed = 0

        for file in files:
            try:
                await search_service.index_file({
                    'id': str(file.id),
                    'name': file.file_name,
                    'original_name': file.file_name,
                    'mime_type': file.mime_type,
                    'size': file.file_size,
                    'hash': file.content_hash,
                    'storage_tier': file.storage_tier if hasattr(file, 'storage_tier') else 'cache',
                    'folder_id': str(file.folder_id) if file.folder_id else None,
                    'user_id': str(file.user_id),
                    'created_at': file.created_at,
                    'updated_at': file.created_at  # Use created_at if updated_at doesn't exist
                })
                indexed += 1
                if indexed % 10 == 0:
                    print(f"Indexed {indexed} files...")
            except Exception as e:
                print(f"Failed to index file {file.id}: {e}")
                failed += 1

        print(f"\nFiles indexing complete: {indexed} indexed, {failed} failed")


async def index_all_folders():
    """Index all existing folders in the database"""
    async with async_session() as session:
        # Get all folders
        result = await session.execute(select(Folder))
        folders = result.scalars().all()

        print(f"Found {len(folders)} folders to index")

        indexed = 0
        failed = 0

        for folder in folders:
            try:
                await search_service.index_folder({
                    'id': str(folder.id),
                    'name': folder.name,
                    'parent_id': str(folder.parent_id) if folder.parent_id else None,
                    'user_id': str(folder.user_id),
                    'path': folder.path,
                    'created_at': folder.created_at,
                    'updated_at': folder.created_at
                })
                indexed += 1
                if indexed % 10 == 0:
                    print(f"Indexed {indexed} folders...")
            except Exception as e:
                print(f"Failed to index folder {folder.id}: {e}")
                failed += 1

        print(f"\nFolders indexing complete: {indexed} indexed, {failed} failed")


async def main():
    """Main migration function"""
    print("Starting Elasticsearch indexing migration...\n")

    # Connect to Elasticsearch
    await search_service.connect()
    print("Connected to Elasticsearch\n")

    # Index all folders first
    await index_all_folders()

    # Then index all files
    await index_all_files()

    # Close connection
    await search_service.close()
    print("\nMigration complete!")


if __name__ == "__main__":
    asyncio.run(main())
