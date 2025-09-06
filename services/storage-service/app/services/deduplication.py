# services/storage-service/app/services/deduplication.py

import hashlib
import os
from typing import Optional, Dict, Tuple
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func
from datetime import datetime
import aiofiles
from ..models.database import Object, ContentBlock
from ..config import settings
import json

class DeduplicationService:
    """
    Content-Addressed Storage (CAS) with deduplication.
    
    Key concepts:
    - Files are split into blocks (chunks)
    - Each block is hashed (SHA-256)
    - Identical blocks are stored only once
    - Files are reconstructed from block references
    """
    
    def __init__(self):
        self.block_size = 4 * 1024 * 1024  # 4MB blocks for deduplication
        self.cas_path = getattr(settings, 'CAS_PATH', '/app/storage/cas')
        
    def calculate_block_hash(self, data: bytes) -> str:
        """Calculate SHA-256 hash of data block"""
        return hashlib.sha256(data).hexdigest()
    
    def get_content_address(self, content_hash: str) -> str:
        """
        Get storage path for content hash.
        Uses first 2 chars for sharding: /cas/ab/abcdef123456...
        """
        shard = content_hash[:2]
        return os.path.join(self.cas_path, shard, content_hash)
    
    async def store_block(self, data: bytes, encrypt: bool = True) -> Tuple[str, int, bool]:
        """
        Store a block of data in CAS.
        Returns: (content_hash, size, is_duplicate)
        """
        # Calculate hash
        content_hash = self.calculate_block_hash(data)
        content_path = self.get_content_address(content_hash)
        
        # Check if block already exists (deduplication)
        if os.path.exists(content_path):
            return content_hash, len(data), True
        
        # Create directory if needed
        os.makedirs(os.path.dirname(content_path), exist_ok=True)
        
        # Encrypt if requested
        if encrypt:
            from ..services.encryption import encryption_service
            block_key = encryption_service.generate_file_key()
            encrypted_data = encryption_service.encrypt_file(data, block_key)
            
            # Store encrypted block
            async with aiofiles.open(content_path, 'wb') as f:
                await f.write(encrypted_data)
            
            # Store key mapping (in production, use secure key storage)
            key_path = content_path + '.key'
            async with aiofiles.open(key_path, 'w') as f:
                encrypted_key = encryption_service.encrypt_key(block_key)
                await f.write(encrypted_key)
        else:
            # Store raw block
            async with aiofiles.open(content_path, 'wb') as f:
                await f.write(data)
        
        return content_hash, len(data), False
    
    async def retrieve_block(self, content_hash: str, decrypt: bool = True) -> bytes:
        """Retrieve a block from CAS"""
        content_path = self.get_content_address(content_hash)
        
        if not os.path.exists(content_path):
            raise FileNotFoundError(f"Block {content_hash} not found")
        
        async with aiofiles.open(content_path, 'rb') as f:
            data = await f.read()
        
        if decrypt and os.path.exists(content_path + '.key'):
            from ..services.encryption import encryption_service
            
            # Read encryption key
            async with aiofiles.open(content_path + '.key', 'r') as f:
                encrypted_key = await f.read()
            
            block_key = encryption_service.decrypt_key(encrypted_key)
            data = encryption_service.decrypt_file(data, block_key)
        
        return data
    
    async def deduplicate_file(
        self, 
        file_data: bytes,
        file_name: str,
        db: AsyncSession
    ) -> Dict:
        """
        Process file for deduplication.
        Returns metadata including block hashes and dedup stats.
        """
        blocks = []
        total_size = len(file_data)
        deduplicated_size = 0
        saved_size = 0
        
        # Split file into blocks
        for i in range(0, total_size, self.block_size):
            block = file_data[i:i + self.block_size]
            
            # Store block and check if it's a duplicate
            block_hash, block_size, is_duplicate = await self.store_block(block)
            
            blocks.append({
                'hash': block_hash,
                'size': block_size,
                'offset': i,
                'is_duplicate': is_duplicate
            })
            
            if is_duplicate:
                saved_size += block_size
            else:
                deduplicated_size += block_size
        
        # Calculate file-level hash
        file_hash = self.calculate_block_hash(file_data)
        
        # Check if entire file is duplicate
        existing_file = await db.execute(
            select(Object).where(Object.content_hash == file_hash)
        )
        is_duplicate_file = existing_file.scalar_one_or_none() is not None
        
        return {
            'file_hash': file_hash,
            'blocks': blocks,
            'total_size': total_size,
            'deduplicated_size': deduplicated_size,
            'saved_size': saved_size,
            'dedup_ratio': (saved_size / total_size * 100) if total_size > 0 else 0,
            'is_duplicate_file': is_duplicate_file,
            'block_count': len(blocks)
        }
    
    async def store_file_with_dedup(
        self,
        file_data: bytes,
        file_name: str,
        user_id: str,
        db: AsyncSession,
        metadata: Optional[Dict] = None
    ) -> Dict:
        """
        Store file using content-addressed storage with deduplication.
        """
        # Deduplicate the file
        dedup_result = await self.deduplicate_file(file_data, file_name, db)
        
        # If entire file is duplicate, just create a reference
        if dedup_result['is_duplicate_file']:
            # Create new file entry pointing to existing content
            new_file = Object(
                file_name=file_name,
                user_id=user_id,
                content_hash=dedup_result['file_hash'],
                file_size=dedup_result['total_size'],
                storage_type='deduplicated',
                dedup_info={
                    'blocks': dedup_result['blocks'],
                    'saved_size': dedup_result['total_size'],
                    'is_reference': True
                },
                metadata=metadata
            )
            db.add(new_file)
            
            # Update dedup statistics
            await self.update_dedup_stats(db, user_id, dedup_result['total_size'])
            
            return {
                'file_id': str(new_file.id),
                'status': 'deduplicated',
                'saved_size': dedup_result['total_size'],
                'dedup_ratio': 100.0
            }
        
        # Store unique file with block references
        new_file = Object(
            file_name=file_name,
            user_id=user_id,
            content_hash=dedup_result['file_hash'],
            file_size=dedup_result['total_size'],
            storage_type='content_addressed',
            dedup_info={
                'blocks': dedup_result['blocks'],
                'saved_size': dedup_result['saved_size'],
                'dedup_ratio': dedup_result['dedup_ratio']
            },
            metadata=metadata
        )
        db.add(new_file)
        
        # Track block references
        for block in dedup_result['blocks']:
            block_ref = ContentBlock(
                block_hash=block['hash'],
                file_id=new_file.id,
                block_size=block['size'],
                block_offset=block['offset'],
                reference_count=1 if not block['is_duplicate'] else 0
            )
            db.add(block_ref)
        
        await db.commit()
        
        return {
            'file_id': str(new_file.id),
            'status': 'stored',
            'saved_size': dedup_result['saved_size'],
            'dedup_ratio': dedup_result['dedup_ratio'],
            'blocks': len(dedup_result['blocks'])
        }
    
    async def retrieve_file_from_cas(
        self,
        file_id: str,
        db: AsyncSession
    ) -> bytes:
        """
        Reconstruct file from content-addressed blocks.
        """
        # Get file metadata
        result = await db.execute(
            select(Object).where(Object.id == file_id)
        )
        file_obj = result.scalar_one_or_none()
        
        if not file_obj:
            raise FileNotFoundError(f"File {file_id} not found")
        
        # Get blocks info
        blocks_info = file_obj.dedup_info.get('blocks', [])
        
        # Reconstruct file from blocks
        file_data = bytearray()
        for block_info in sorted(blocks_info, key=lambda x: x['offset']):
            block_data = await self.retrieve_block(block_info['hash'])
            file_data.extend(block_data)
        
        return bytes(file_data)
    
    async def get_dedup_statistics(self, db: AsyncSession, user_id: Optional[str] = None) -> Dict:
        """
        Get deduplication statistics for user or system.
        """
        if user_id:
            # User-specific stats
            result = await db.execute(
                select(
                    func.count(Object.id).label('total_files'),
                    func.sum(Object.file_size).label('logical_size'),
                    func.sum(
                        func.cast(
                            Object.dedup_info['saved_size'], 
                            Integer
                        )
                    ).label('saved_size')
                ).where(
                    Object.user_id == user_id,
                    Object.storage_type.in_(['deduplicated', 'content_addressed'])
                )
            )
        else:
            # System-wide stats
            result = await db.execute(
                select(
                    func.count(Object.id).label('total_files'),
                    func.sum(Object.file_size).label('logical_size'),
                    func.count(func.distinct(Object.content_hash)).label('unique_files')
                ).where(
                    Object.storage_type.in_(['deduplicated', 'content_addressed'])
                )
            )
        
        stats = result.first()
        
        logical_size = stats.logical_size or 0
        saved_size = stats.saved_size or 0
        physical_size = logical_size - saved_size
        
        return {
            'total_files': stats.total_files or 0,
            'logical_size': logical_size,
            'physical_size': physical_size,
            'saved_size': saved_size,
            'dedup_ratio': (saved_size / logical_size * 100) if logical_size > 0 else 0,
            'unique_files': getattr(stats, 'unique_files', None)
        }
    
    async def cleanup_unreferenced_blocks(self, db: AsyncSession) -> int:
        """
        Remove blocks that are no longer referenced by any file.
        Returns number of blocks cleaned up.
        """
        # Find unreferenced blocks
        result = await db.execute(
            select(ContentBlock.block_hash)
            .group_by(ContentBlock.block_hash)
            .having(func.sum(ContentBlock.reference_count) == 0)
        )
        
        unreferenced = result.scalars().all()
        
        # Delete unreferenced blocks from storage
        deleted_count = 0
        for block_hash in unreferenced:
            content_path = self.get_content_address(block_hash)
            if os.path.exists(content_path):
                os.remove(content_path)
                # Also remove key file if it exists
                if os.path.exists(content_path + '.key'):
                    os.remove(content_path + '.key')
                deleted_count += 1
        
        # Remove from database
        if unreferenced:
            await db.execute(
                delete(ContentBlock).where(
                    ContentBlock.block_hash.in_(unreferenced)
                )
            )
            await db.commit()
        
        return deleted_count
    
    async def update_dedup_stats(self, db: AsyncSession, user_id: str, saved_bytes: int):
        """Update user's deduplication savings"""
        # This could be tracked in a separate stats table
        # For now, we'll just log it
        print(f"User {user_id} saved {saved_bytes} bytes through deduplication")


# Singleton instance
deduplication_service = DeduplicationService()


# Add to models/database.py
"""

"""