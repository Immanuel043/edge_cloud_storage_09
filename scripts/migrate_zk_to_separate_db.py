#!/usr/bin/env python3
"""
ZK Data Migration Script

Migrates Zero-Knowledge users and objects from the shared storage database
to the separate ZK database.

IMPORTANT: Run this script during a maintenance window.
The migration is designed to be idempotent - safe to run multiple times.

Usage:
    # Dry run (no changes)
    python scripts/migrate_zk_to_separate_db.py --dry-run

    # Actual migration
    python scripts/migrate_zk_to_separate_db.py --execute

    # With custom database URLs
    python scripts/migrate_zk_to_separate_db.py --execute \
        --source-db "postgresql://..." \
        --target-db "postgresql://..."
"""
import asyncio
import argparse
import logging
from datetime import datetime
from typing import Optional
from uuid import UUID

import asyncpg

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

# Default database URLs
DEFAULT_SOURCE_DB = "postgresql://edge_admin:secure_password@localhost:5432/edge_cloud"
DEFAULT_TARGET_DB = "postgresql://zk_admin:secure_password@localhost:5432/zk_db"


async def get_zk_users(source_conn) -> list:
    """Fetch all ZK-enabled users from source database."""
    # Query for ZK-enabled users (zk_enabled column may have been removed)
    # Try to find users with encrypted_master_key set (indicates ZK enrollment)
    query = """
        SELECT 
            id, email, username, password_hash, 
            COALESCE(plan_type, 'free') as plan_type,
            storage_quota, storage_used, is_active,
            created_at, encrypted_master_key,
            kdf_salt, kdf_algorithm, kdf_iterations
        FROM users
        WHERE encrypted_master_key IS NOT NULL
    """
    return await source_conn.fetch(query)


async def get_zk_objects(source_conn, user_id: UUID) -> list:
    """Fetch all ZK objects for a user from source database."""
    query = """
        SELECT 
            id, user_id, folder_id, file_name, file_size, mime_type,
            created_at, updated_at, is_deleted, deleted_at,
            encryption_mode, is_encrypted, encrypted_file_key, file_key_iv,
            encryption_algorithm, encryption_version, upload_status,
            upload_id, uploaded_at, file_hash, file_metadata,
            chunk_info, object_path, content_hash
        FROM objects
        WHERE user_id = $1 AND encryption_mode = 'client_zk'
    """
    return await source_conn.fetch(query, user_id)


async def user_exists_in_target(target_conn, email: str) -> bool:
    """Check if user already exists in target database."""
    result = await target_conn.fetchval(
        "SELECT id FROM zk_users WHERE email = $1", email
    )
    return result is not None


async def migrate_user(target_conn, user: dict, dry_run: bool) -> Optional[UUID]:
    """
    Migrate a single user to the ZK database.
    
    Returns the user ID if successful, None if skipped.
    """
    email = user['email']
    
    # Check if already migrated
    if await user_exists_in_target(target_conn, email):
        logger.info(f"User {email} already exists in ZK database, skipping")
        return user['id']
    
    if dry_run:
        logger.info(f"[DRY RUN] Would migrate user: {email}")
        return user['id']
    
    # Insert into zk_users table
    query = """
        INSERT INTO zk_users (
            id, email, username, password_hash, plan_type,
            storage_quota, storage_used, is_active, created_at,
            encrypted_master_key, master_key_iv, kdf_salt, kdf_algorithm,
            kdf_iterations, kdf_memory, kdf_parallelism,
            recovery_phrase_enabled, recovery_phrase_verified,
            recovery_encrypted_master_key, recovery_phrase_hash,
            zk_enrolled_at
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18, $19, $20, $21
        )
        ON CONFLICT (id) DO NOTHING
    """
    
    # Map old plan_type to new ZK plan_type (default to 'free')
    plan_type = 'free'
    old_plan = user.get('plan_type', 'free')
    if old_plan in ['basic', 'pro']:
        plan_type = 'personal'  # Map to closest ZK plan
    elif old_plan in ['team', 'enterprise']:
        plan_type = 'professional'  # Map to closest ZK plan
    
    # Calculate ZK storage quota (use free tier default for migration)
    storage_quota = 1 * 1024**3  # 1GB free tier
    
    await target_conn.execute(
        query,
        user['id'],
        user['email'],
        user['username'],
        user['password_hash'],
        plan_type,
        storage_quota,
        0,  # storage_used will be recalculated
        user['is_active'],
        user['created_at'] or datetime.utcnow(),
        user['encrypted_master_key'],
        user.get('master_key_iv'),
        user['kdf_salt'],
        user['kdf_algorithm'],
        user['kdf_iterations'],
        user.get('kdf_memory'),
        user.get('kdf_parallelism'),
        user['recovery_phrase_enabled'],
        user.get('recovery_phrase_verified', False),
        user['recovery_encrypted_master_key'],
        user['recovery_phrase_hash'],
        user.get('zk_enrolled_at')
    )
    
    logger.info(f"Migrated user: {email}")
    return user['id']


async def object_exists_in_target(target_conn, object_id: UUID) -> bool:
    """Check if object already exists in target database."""
    result = await target_conn.fetchval(
        "SELECT id FROM zk_objects WHERE id = $1", object_id
    )
    return result is not None


async def migrate_object(target_conn, obj: dict, dry_run: bool) -> bool:
    """
    Migrate a single object to the ZK database.
    
    Returns True if migrated, False if skipped.
    """
    if await object_exists_in_target(target_conn, obj['id']):
        logger.debug(f"Object {obj['id']} already exists, skipping")
        return False
    
    if dry_run:
        logger.info(f"[DRY RUN] Would migrate object: {obj['file_name']} ({obj['file_size']} bytes)")
        return True
    
    query = """
        INSERT INTO zk_objects (
            id, user_id, folder_id, encrypted_file_name, file_name_iv,
            file_size, mime_type, encrypted_file_key, file_key_iv,
            encryption_algorithm, encryption_version, storage_path,
            chunk_info, content_hash, upload_status, upload_id,
            created_at, updated_at, uploaded_at, last_accessed_at,
            is_deleted, deleted_at
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
            $14, $15, $16, $17, $18, $19, $20, $21, $22
        )
        ON CONFLICT (id) DO NOTHING
    """
    
    # For migration, we use the plaintext filename as encrypted_file_name
    # In production, these would be actually encrypted
    # The new system will re-encrypt on first access
    encrypted_file_name = obj['file_name']
    file_name_iv = "migration_placeholder"
    
    await target_conn.execute(
        query,
        obj['id'],
        obj['user_id'],
        obj['folder_id'],
        encrypted_file_name,
        file_name_iv,
        obj['file_size'],
        obj['mime_type'],
        obj['encrypted_file_key'],
        obj['file_key_iv'],
        obj['encryption_algorithm'] or 'AES-256-GCM',
        obj['encryption_version'] or 2,
        obj['object_path'],
        obj['chunk_info'],
        obj['content_hash'],
        obj['upload_status'] or 'completed',
        obj['upload_id'],
        obj['created_at'],
        obj['updated_at'],
        obj['uploaded_at'],
        None,  # last_accessed_at
        obj['is_deleted'],
        obj.get('deleted_at')
    )
    
    logger.debug(f"Migrated object: {obj['file_name']}")
    return True


async def update_storage_used(target_conn, user_id: UUID):
    """Recalculate and update storage_used for a user."""
    total = await target_conn.fetchval("""
        SELECT COALESCE(SUM(file_size), 0)
        FROM zk_objects
        WHERE user_id = $1 AND is_deleted = false
    """, user_id)
    
    await target_conn.execute(
        "UPDATE zk_users SET storage_used = $1 WHERE id = $2",
        total, user_id
    )
    
    logger.debug(f"Updated storage_used for user {user_id}: {total} bytes")


async def run_migration(
    source_db_url: str,
    target_db_url: str,
    dry_run: bool = True
):
    """
    Run the ZK data migration.
    """
    logger.info("=" * 60)
    logger.info("ZK Data Migration")
    logger.info("=" * 60)
    logger.info(f"Source: {source_db_url.split('@')[1] if '@' in source_db_url else source_db_url}")
    logger.info(f"Target: {target_db_url.split('@')[1] if '@' in target_db_url else target_db_url}")
    logger.info(f"Mode: {'DRY RUN' if dry_run else 'EXECUTE'}")
    logger.info("=" * 60)
    
    # Connect to both databases
    source_conn = await asyncpg.connect(source_db_url)
    target_conn = await asyncpg.connect(target_db_url)
    
    try:
        # Get all ZK users from source
        users = await get_zk_users(source_conn)
        logger.info(f"Found {len(users)} ZK-enabled users to migrate")
        
        if len(users) == 0:
            logger.info("No ZK users found. Migration complete.")
            return
        
        total_users_migrated = 0
        total_objects_migrated = 0
        total_bytes_migrated = 0
        
        for user in users:
            user_id = await migrate_user(target_conn, dict(user), dry_run)
            if user_id:
                total_users_migrated += 1
                
                # Get and migrate user's ZK objects
                objects = await get_zk_objects(source_conn, user['id'])
                logger.info(f"Found {len(objects)} ZK objects for user {user['email']}")
                
                for obj in objects:
                    if await migrate_object(target_conn, dict(obj), dry_run):
                        total_objects_migrated += 1
                        total_bytes_migrated += obj['file_size']
                
                # Update storage_used
                if not dry_run:
                    await update_storage_used(target_conn, user_id)
        
        logger.info("=" * 60)
        logger.info("Migration Summary")
        logger.info("=" * 60)
        logger.info(f"Users migrated: {total_users_migrated}")
        logger.info(f"Objects migrated: {total_objects_migrated}")
        logger.info(f"Total data: {total_bytes_migrated / (1024**3):.2f} GB")
        
        if dry_run:
            logger.info("")
            logger.info("This was a DRY RUN. No changes were made.")
            logger.info("Run with --execute to perform the actual migration.")
        else:
            logger.info("")
            logger.info("Migration completed successfully!")
            logger.info("")
            logger.info("Next steps:")
            logger.info("1. Verify data in ZK database")
            logger.info("2. Update ZK service config to use ZK_DATABASE_URL")
            logger.info("3. Test ZK service with new database")
            logger.info("4. After validation, clean ZK data from storage DB")
    
    finally:
        await source_conn.close()
        await target_conn.close()


def main():
    parser = argparse.ArgumentParser(
        description="Migrate ZK data from shared database to separate ZK database"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be migrated without making changes"
    )
    parser.add_argument(
        "--execute",
        action="store_true",
        help="Actually perform the migration"
    )
    parser.add_argument(
        "--source-db",
        default=DEFAULT_SOURCE_DB,
        help="Source database URL (storage service DB)"
    )
    parser.add_argument(
        "--target-db",
        default=DEFAULT_TARGET_DB,
        help="Target database URL (ZK service DB)"
    )
    
    args = parser.parse_args()
    
    if not args.dry_run and not args.execute:
        print("Error: Must specify either --dry-run or --execute")
        print("Use --dry-run to preview changes, --execute to apply them")
        return 1
    
    if args.dry_run and args.execute:
        print("Error: Cannot specify both --dry-run and --execute")
        return 1
    
    dry_run = args.dry_run
    
    asyncio.run(run_migration(args.source_db, args.target_db, dry_run))
    return 0


if __name__ == "__main__":
    exit(main())

