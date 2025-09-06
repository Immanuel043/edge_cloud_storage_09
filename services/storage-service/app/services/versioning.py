# services/storage-service/app/services/versioning.py

from typing import Optional, List
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from ..models.database import Object, FileVersion
from ..services.storage import storage_service
import json

class VersioningService:
    
    async def create_version(
        self,
        db: AsyncSession,
        file_id: str,
        new_content: bytes,
        user_id: str,
        comment: Optional[str] = None
    ) -> FileVersion:
        """Create a new version of a file"""
        
        # Get current file
        result = await db.execute(
            select(Object).filter(Object.id == file_id)
        )
        current_file = result.scalar_one_or_none()
        
        if not current_file:
            raise ValueError(f"File {file_id} not found")
        
        if not current_file.versioning_enabled:
            raise ValueError(f"Versioning disabled for file {file_id}")
        
        # Save current version as history before updating
        await self._archive_current_version(db, current_file)
        
        # Process new content
        content_hash = hashlib.sha256(new_content).hexdigest()
        
        # Store new version data
        if len(new_content) < 1048576:  # 1MB - inline
            storage_info = await storage_service.store_inline(
                new_content,
                {"user_id": str(user_id)},
                current_file.encryption_key
            )
        else:
            storage_info = await storage_service.store_single(
                new_content,
                {"user_id": str(user_id)},
                current_file.encryption_key
            )
        
        # Create version record
        new_version_number = current_file.current_version + 1
        version = FileVersion(
            file_id=file_id,
            version_number=new_version_number,
            file_size=len(new_content),
            content_hash=content_hash,
            storage_path=storage_info.get('path') or storage_info.get('storage_key'),
            chunk_info=storage_info,
            created_by=user_id,
            comment=comment
        )
        
        # Update main file record
        current_file.current_version = new_version_number
        current_file.version_count = new_version_number
        current_file.file_size = len(new_content)
        current_file.content_hash = content_hash
        current_file.last_accessed = datetime.utcnow()
        
        db.add(version)
        await db.commit()
        
        return version
    
    async def _archive_current_version(self, db: AsyncSession, file_obj: Object):
        """Archive the current version before creating new one"""
        
        # Check if current version already archived
        existing = await db.execute(
            select(FileVersion).filter(
                FileVersion.file_id == file_obj.id,
                FileVersion.version_number == file_obj.current_version
            )
        )
        
        if not existing.scalar_one_or_none():
            # Create archive entry for current version
            archive = FileVersion(
                file_id=file_obj.id,
                version_number=file_obj.current_version,
                file_size=file_obj.file_size,
                content_hash=file_obj.content_hash,
                storage_path=file_obj.object_path or file_obj.storage_key,
                chunk_info=file_obj.chunk_info,
                created_by=file_obj.user_id,
                created_at=file_obj.created_at
            )
            db.add(archive)
    
    async def get_version(
        self,
        db: AsyncSession,
        file_id: str,
        version_number: int
    ) -> FileVersion:
        """Get specific version of a file"""
        
        result = await db.execute(
            select(FileVersion).filter(
                FileVersion.file_id == file_id,
                FileVersion.version_number == version_number
            )
        )
        return result.scalar_one_or_none()
    
    async def list_versions(
        self,
        db: AsyncSession,
        file_id: str,
        include_deleted: bool = False
    ) -> List[FileVersion]:
        """List all versions of a file"""
        
        query = select(FileVersion).filter(FileVersion.file_id == file_id)
        
        if not include_deleted:
            query = query.filter(FileVersion.is_deleted == False)
        
        query = query.order_by(FileVersion.version_number.desc())
        
        result = await db.execute(query)
        return result.scalars().all()
    
    async def restore_version(
        self,
        db: AsyncSession,
        file_id: str,
        version_number: int,
        user_id: str
    ) -> Object:
        """Restore a specific version as the current version"""
        
        # Get the version to restore
        version = await self.get_version(db, file_id, version_number)
        if not version:
            raise ValueError(f"Version {version_number} not found")
        
        # Get current file
        result = await db.execute(
            select(Object).filter(Object.id == file_id)
        )
        current_file = result.scalar_one_or_none()
        
        # Archive current version
        await self._archive_current_version(db, current_file)
        
        # Restore the selected version
        new_version_number = current_file.current_version + 1
        
        # Create new version entry (restore is a new version)
        restored_version = FileVersion(
            file_id=file_id,
            version_number=new_version_number,
            file_size=version.file_size,
            content_hash=version.content_hash,
            storage_path=version.storage_path,
            chunk_info=version.chunk_info,
            created_by=user_id,
            comment=f"Restored from version {version_number}"
        )
        
        # Update main file
        current_file.current_version = new_version_number
        current_file.version_count = new_version_number
        current_file.file_size = version.file_size
        current_file.content_hash = version.content_hash
        
        db.add(restored_version)
        await db.commit()
        
        return current_file
    
    async def diff_versions(
        self,
        db: AsyncSession,
        file_id: str,
        version1: int,
        version2: int
    ) -> dict:
        """Compare two versions"""
        
        v1 = await self.get_version(db, file_id, version1)
        v2 = await self.get_version(db, file_id, version2)
        
        if not v1 or not v2:
            raise ValueError("One or both versions not found")
        
        return {
            "version1": version1,
            "version2": version2,
            "size_change": v2.file_size - v1.file_size,
            "hash_changed": v1.content_hash != v2.content_hash,
            "time_diff": (v2.created_at - v1.created_at).total_seconds(),
            "v1_info": {
                "size": v1.file_size,
                "hash": v1.content_hash,
                "created": v1.created_at.isoformat(),
                "created_by": str(v1.created_by)
            },
            "v2_info": {
                "size": v2.file_size,
                "hash": v2.content_hash,
                "created": v2.created_at.isoformat(),
                "created_by": str(v2.created_by)
            }
        }

versioning_service = VersioningService()