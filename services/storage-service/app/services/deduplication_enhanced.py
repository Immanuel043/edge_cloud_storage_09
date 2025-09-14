# services/storage-service/app/services/deduplication_enhanced.py
import hashlib
import os
import asyncio
from typing import Optional, Dict, Tuple, List
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select, func, update, and_
from datetime import datetime
import aiofiles
from ..models.database import Object, ContentBlock, User
from ..config import settings
from ..services.encryption import encryption_service
import json
import xxhash  # For faster non-cryptographic hashing
from collections import defaultdict

class EnhancedDeduplicationService:
    """
    Enhanced Content-Addressed Storage with improved deduplication.
    
    Improvements:
    - Variable block size with content-defined chunking
    - Pre-encryption deduplication for better ratios
    - Global deduplication across users (optional)
    - Bloom filter for quick duplicate detection
    - Async batch processing
    """
    
    def __init__(self):
        self.min_block_size = 2 * 1024 * 1024   # 2MB min
        self.avg_block_size = 4 * 1024 * 1024   # 4MB average
        self.max_block_size = 8 * 1024 * 1024   # 8MB max
        self.cas_path = getattr(settings, 'CAS_PATH', '/app/storage/cas')
        self.enable_cross_user_dedup = getattr(settings, 'CROSS_USER_DEDUP', False)
        
        # Rabin fingerprinting parameters for CDC
        self.window_size = 48
        self.prime = 3
        self.modulus = (1 << 13) - 1  # For average 4MB chunks
        
        # Bloom filter for quick duplicate detection (optional)
        self._init_bloom_filter()
        
    def _init_bloom_filter(self):
        """Initialize bloom filter for quick duplicate detection"""
        try:
            from pybloom_live import BloomFilter
            self.bloom_filter = BloomFilter(capacity=1000000, error_rate=0.001)
            self.bloom_enabled = True
        except ImportError:
            self.bloom_filter = None
            self.bloom_enabled = False
    
    def calculate_block_hash(self, data: bytes) -> str:
        """Calculate SHA-256 hash of data block"""
        return hashlib.sha256(data).hexdigest()
    
    def calculate_weak_hash(self, data: bytes) -> str:
        """Calculate fast weak hash for initial duplicate detection"""
        return xxhash.xxh64(data).hexdigest()
    
    def find_chunk_boundaries(self, data: bytes) -> List[int]:
        """
        Content-defined chunking using rolling hash.
        Returns list of chunk boundary positions.
        """
        if len(data) < self.min_block_size:
            return [len(data)]
        
        boundaries = []
        hash_val = 0
        
        for i in range(len(data)):
            # Rolling hash calculation
            if i >= self.window_size:
                hash_val = (hash_val * self.prime + data[i] - 
                           data[i - self.window_size] * (self.prime ** self.window_size)) % (2**32)
            else:
                hash_val = (hash_val * self.prime + data[i]) % (2**32)
            
            # Check for boundary
            if i >= self.min_block_size:
                if (hash_val & self.modulus) == self.modulus:
                    boundaries.append(i + 1)
                elif i - (boundaries[-1] if boundaries else 0) >= self.max_block_size:
                    boundaries.append(i + 1)
        
        # Add final boundary
        if not boundaries or boundaries[-1] != len(data):
            boundaries.append(len(data))
        
        return boundaries
    
    
    async def deduplicate_before_encryption(
        self,
        file_data: bytes,
        file_name: str,
        user_id: str,
        db: AsyncSession
    ) -> Dict:
        """
        Perform deduplication before encryption for better dedup ratios.
        This finds duplicate blocks across all users if enabled.
        """
        blocks = []
        boundaries = self.find_chunk_boundaries(file_data)
        
        total_size = len(file_data)
        deduplicated_size = 0
        saved_size = 0
        new_blocks = []
        duplicate_blocks = []
        
        start = 0
        for boundary in boundaries:
            block = file_data[start:boundary]
            block_hash = self.calculate_block_hash(block)
            
            # Quick check with bloom filter
            is_potential_duplicate = False
            if self.bloom_enabled and block_hash in self.bloom_filter:
                is_potential_duplicate = True
            
            # Database check for existing block - FIXED to handle multiple results
            query = select(ContentBlock).where(ContentBlock.block_hash == block_hash)
            if not self.enable_cross_user_dedup:
                # Limit to user's own blocks
                query = query.join(Object).where(Object.user_id == user_id)
            
            # Order by created_at to get the oldest block first
            query = query.order_by(ContentBlock.created_at.asc())
            
            result = await db.execute(query)
            existing_block = result.scalars().first()  # Use .first() instead of .scalar_one_or_none()
            
            if existing_block:
                # Duplicate found
                duplicate_blocks.append({
                    'hash': block_hash,
                    'size': len(block),
                    'offset': start,
                    'existing_block_id': str(existing_block.id)
                })
                saved_size += len(block)
                
                # Increment reference count
                await db.execute(
                    update(ContentBlock)
                    .where(ContentBlock.id == existing_block.id)
                    .values(reference_count=ContentBlock.reference_count + 1)
                )
            else:
                # New unique block
                new_blocks.append({
                    'hash': block_hash,
                    'size': len(block),
                    'offset': start,
                    'data': block  # Keep for storage
                })
                deduplicated_size += len(block)
                
                # Add to bloom filter
                if self.bloom_enabled:
                    self.bloom_filter.add(block_hash)
            
            blocks.append({
                'hash': block_hash,
                'size': len(block),
                'offset': start,
                'is_duplicate': existing_block is not None
            })
            
            start = boundary
        
        return {
            'blocks': blocks,
            'new_blocks': new_blocks,
            'duplicate_blocks': duplicate_blocks,
            'total_size': total_size,
            'deduplicated_size': deduplicated_size,
            'saved_size': saved_size,
            'dedup_ratio': (saved_size / total_size * 100) if total_size > 0 else 0,
            'block_count': len(blocks)
        }
    

    def derive_key_from_content(self, data: bytes) -> bytes:
        """
        Derive encryption key from content hash (convergent encryption).
        This ensures identical data always gets encrypted the same way.
        """
        # Use PBKDF2 to derive a key from the content hash
        content_hash = hashlib.sha256(data).digest()
        # Use a fixed salt for convergent encryption (not random!)
        salt = b'dedup_convergent_encryption_salt'
        key = hashlib.pbkdf2_hmac('sha256', content_hash, salt, 100000, dklen=32)
        return key

    async def store_deduplicated_file(
        self,
        file_data: bytes,
        file_name: str,
        user_id: str,
        db: AsyncSession,
        metadata: Optional[Dict] = None,
        encrypt: bool = True
    ) -> Dict:
        """
        Enhanced file storage with pre-encryption deduplication.
        """
        try:
            # Perform deduplication analysis
            dedup_result = await self.deduplicate_before_encryption(
                file_data, file_name, user_id, db
            )
            
            # Calculate file-level hash
            file_hash = self.calculate_block_hash(file_data)
            
            # Check for full-file duplicate
            query = select(Object).where(
                Object.content_hash == file_hash,
                Object.user_id == user_id if not self.enable_cross_user_dedup else True
            ).order_by(Object.created_at.asc())
            
            result = await db.execute(query)
            existing_file = result.scalars().first()
            
            if existing_file:
                # Full file duplicate found
                print(f"🎯 Full duplicate found! File hash: {file_hash[:16]}...")
                
                new_file = Object(
                    file_name=file_name,
                    user_id=user_id,
                    content_hash=file_hash,
                    file_size=dedup_result['total_size'],
                    storage_type='deduplicated_reference',
                    dedup_info={
                        'reference_file_id': str(existing_file.id),
                        'is_full_duplicate': True,
                        'saved_size': dedup_result['total_size']
                    },
                    mime_type=metadata.get('mime_type') if metadata else None,
                    folder_id=metadata.get('folder_id') if metadata else None,
                    # Reference the same encryption key
                    encryption_key=existing_file.encryption_key
                )
                db.add(new_file)
                await db.commit()
                
                return {
                    'file_id': str(new_file.id),
                    'status': 'full_duplicate',
                    'saved_size': dedup_result['total_size'],
                    'dedup_ratio': 100.0,
                    'duplicate_blocks': []
                }
            
            # Store new unique blocks
            stored_blocks = []
            
            # For convergent encryption, use a master key for the file metadata
            # but derive block keys from content
            if encrypt:
                # Generate a master key for file metadata (user-specific)
                master_key = encryption_service.generate_file_key()
                encrypted_master_key = encryption_service.encrypt_key(master_key)
            else:
                master_key = None
                encrypted_master_key = None
            
            for new_block in dedup_result['new_blocks']:
                block_data = new_block['data']
                
                # Check if this block already exists in CAS
                content_path = self.get_content_address(new_block['hash'])
                
                if not os.path.exists(content_path):
                    # Block doesn't exist, store it
                    if encrypt:
                        # Use convergent encryption - derive key from content
                        block_key = self.derive_key_from_content(block_data)
                        
                        # Encrypt using AES-GCM with the derived key
                        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
                        from cryptography.hazmat.backends import default_backend
                        import os as crypto_os
                        
                        # Generate a deterministic nonce from block hash
                        nonce = hashlib.sha256(f"{new_block['hash']}_nonce".encode()).digest()[:12]
                        
                        cipher = Cipher(
                            algorithms.AES(block_key),
                            modes.GCM(nonce),
                            backend=default_backend()
                        )
                        encryptor = cipher.encryptor()
                        encrypted_data = encryptor.update(block_data) + encryptor.finalize()
                        
                        # Store encrypted block with tag
                        block_to_store = nonce + encryptor.tag + encrypted_data
                        
                        print(f"📦 Storing new block {new_block['hash'][:8]}... ({len(block_data)/1024:.1f}KB)")
                    else:
                        block_to_store = block_data
                    
                    # Create directory if needed
                    os.makedirs(os.path.dirname(content_path), exist_ok=True)
                    
                    # Store block
                    async with aiofiles.open(content_path, 'wb') as f:
                        await f.write(block_to_store)
                else:
                    print(f"♻️ Block {new_block['hash'][:8]}... already exists, reusing")
                
                stored_blocks.append({
                    'hash': new_block['hash'],
                    'path': content_path,
                    'size': new_block['size'],
                    'offset': new_block['offset']
                })
            
            # Create file object with dedup info
            new_file = Object(
                file_name=file_name,
                user_id=user_id,
                content_hash=file_hash,
                file_size=dedup_result['total_size'],
                storage_type='content_addressed',
                chunk_info={
                    'blocks': dedup_result['blocks'],
                    'stored_blocks': stored_blocks,
                    'version': 2,
                    'convergent_encryption': encrypt  # Mark as using convergent encryption
                },
                dedup_info={
                    'saved_size': dedup_result['saved_size'],
                    'dedup_ratio': dedup_result['dedup_ratio'],
                    'unique_blocks': len(dedup_result['new_blocks']),
                    'duplicate_blocks': len(dedup_result['duplicate_blocks'])
                },
                mime_type=metadata.get('mime_type') if metadata else None,
                folder_id=metadata.get('folder_id') if metadata else None,
                encryption_key=encrypted_master_key  # Store master key for metadata
            )
            db.add(new_file)
            
            # Create ContentBlock entries for new blocks only
            for block in dedup_result['blocks']:
                if not block['is_duplicate']:
                    content_block = ContentBlock(
                        block_hash=block['hash'],
                        file_id=new_file.id,
                        block_size=block['size'],
                        block_offset=block['offset'],
                        reference_count=1
                    )
                    db.add(content_block)
            
            await db.commit()
            
            print(f"✅ File stored with deduplication:")
            print(f"   - Unique blocks: {len(dedup_result['new_blocks'])}")
            print(f"   - Duplicate blocks: {len(dedup_result['duplicate_blocks'])}")
            print(f"   - Saved: {dedup_result['saved_size']/1024/1024:.1f}MB ({dedup_result['dedup_ratio']:.1f}%)")
            
            return {
                'file_id': str(new_file.id),
                'status': 'stored_with_dedup',
                'saved_size': dedup_result['saved_size'],
                'dedup_ratio': dedup_result['dedup_ratio'],
                'unique_blocks': len(dedup_result['new_blocks']),
                'total_blocks': len(dedup_result['blocks']),
                'duplicate_blocks': dedup_result['duplicate_blocks']
            }
            
        except Exception as e:
            await db.rollback()
            raise Exception(f"Deduplication failed: {str(e)}")
    
    
    async def get_deduplication_analytics(
        self,
        db: AsyncSession,
        user_id: Optional[str] = None
    ) -> Dict:
        """
        Get detailed deduplication analytics.
        """
        # Base query
        if user_id:
            # User-specific analytics
            objects_query = select(Object).where(
                Object.user_id == user_id,
                Object.storage_type.in_(['content_addressed', 'deduplicated_reference'])
            )
            blocks_query = select(ContentBlock).join(Object).where(Object.user_id == user_id)
        else:
            # System-wide analytics
            objects_query = select(Object).where(
                Object.storage_type.in_(['content_addressed', 'deduplicated_reference'])
            )
            blocks_query = select(ContentBlock)
        
        # Get file statistics
        files_result = await db.execute(objects_query)
        files = files_result.scalars().all()
        
        total_files = len(files)
        total_logical_size = sum(f.file_size for f in files)
        total_saved = sum(
            f.dedup_info.get('saved_size', 0) 
            for f in files 
            if f.dedup_info
        )
        
        # Get block statistics - FIXED query
        blocks_result = await db.execute(
            select(
                func.count(ContentBlock.id).label('total_blocks'),
                func.sum(ContentBlock.block_size).label('total_block_size'),
                func.avg(ContentBlock.reference_count).label('avg_references')
            )
        )
        block_stats = blocks_result.first()
        
        # Calculate metrics
        physical_size = total_logical_size - total_saved
        dedup_ratio = (total_saved / total_logical_size * 100) if total_logical_size > 0 else 0
        
        # Get top duplicate blocks
        top_duplicates = await db.execute(
            select(
                ContentBlock.block_hash,
                ContentBlock.block_size,
                func.count(ContentBlock.id).label('count')
            )
            .group_by(ContentBlock.block_hash, ContentBlock.block_size)
            .having(func.count(ContentBlock.id) > 1)
            .order_by(func.count(ContentBlock.id).desc())
            .limit(10)
        )
        
        return {
            'summary': {
                'total_files': total_files,
                'logical_size': total_logical_size,
                'physical_size': physical_size,
                'saved_size': total_saved,
                'dedup_ratio': round(dedup_ratio, 2),
                'compression_ratio': round(total_logical_size / physical_size, 2) if physical_size > 0 else 1
            },
            'blocks': {
                'total_blocks': block_stats.total_blocks or 0,
                'total_size': block_stats.total_block_size or 0,
                'avg_references': float(block_stats.avg_references or 0)
            },
            'top_duplicates': [
                {
                    'hash': row.block_hash[:8] + '...',
                    'size': row.block_size,
                    'count': row.count
                }
                for row in top_duplicates
            ]
        }
    
    async def garbage_collect(self, db: AsyncSession) -> Dict:
        """
        Enhanced garbage collection with safety checks.
        """
        # Find blocks with zero references
        unreferenced = await db.execute(
            select(ContentBlock)
            .where(ContentBlock.reference_count <= 0)
        )
        unreferenced_blocks = unreferenced.scalars().all()
        
        deleted_count = 0
        freed_space = 0
        errors = []
        
        for block in unreferenced_blocks:
            try:
                # Double-check no files reference this block
                file_refs = await db.execute(
                    select(func.count(Object.id))
                    .where(
                        Object.chunk_info['blocks'].contains(
                            [{'hash': block.block_hash}]
                        )
                    )
                )
                ref_count = file_refs.scalar()
                
                if ref_count == 0:
                    # Safe to delete
                    content_path = self.get_content_address(block.block_hash)
                    if os.path.exists(content_path):
                        file_size = os.path.getsize(content_path)
                        os.remove(content_path)
                        freed_space += file_size
                        
                        # Remove key file if exists
                        if os.path.exists(content_path + '.key'):
                            os.remove(content_path + '.key')
                    
                    await db.delete(block)
                    deleted_count += 1
                else:
                    # Fix reference count
                    block.reference_count = ref_count
                    
            except Exception as e:
                errors.append({
                    'block_hash': block.block_hash,
                    'error': str(e)
                })
        
        await db.commit()
        
        return {
            'deleted_blocks': deleted_count,
            'freed_space': freed_space,
            'errors': errors
        }
    
    def get_content_address(self, content_hash: str) -> str:  
        """Get storage path for content hash.
        Uses first 2 chars for sharding: /cas/ab/abcdef123456...
        """
        shard = content_hash[:2]
        return os.path.join(self.cas_path, shard, content_hash)

# Enhanced singleton instance
enhanced_dedup_service = EnhancedDeduplicationService()