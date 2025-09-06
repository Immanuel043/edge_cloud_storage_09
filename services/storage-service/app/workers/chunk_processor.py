# services/storage-service/app/workers/chunk_processor.py

from aiokafka import AIOKafkaConsumer, AIOKafkaProducer
import asyncio
import aiofiles
import os
import json
import hashlib
from ..services.encryption import encryption_service
from ..services.storage import storage_service
from ..database import get_redis

class ChunkProcessor:
    def __init__(self):
        self.consumer = AIOKafkaConsumer(
            'chunk-processing',
            bootstrap_servers='kafka:9092',
            group_id='chunk-processors',
            auto_offset_reset='earliest',
            enable_auto_commit=True,
            max_poll_records=10  # Process 10 chunks at a time
        )
        self.producer = AIOKafkaProducer(
            bootstrap_servers='kafka:9092',
            value_serializer=lambda v: json.dumps(v).encode()
        )
    
    async def start(self):
        await self.consumer.start()
        await self.producer.start()
        
        try:
            async for msg in self.consumer:
                await self.process_chunk(json.loads(msg.value))
        finally:
            await self.consumer.stop()
            await self.producer.stop()
    
    async def process_chunk(self, chunk_info):
        try:
            # Read temp chunk
            async with aiofiles.open(chunk_info['chunk_path'], 'rb') as f:
                chunk_data = await f.read()
            
            # Calculate hash
            chunk_hash = hashlib.sha256(chunk_data).hexdigest()
            
            # Decrypt key
            file_key = encryption_service.decrypt_key(chunk_info['encryption_key'])
            
            # Save chunk with dedup, compression, encryption
            await storage_service.save_chunk(chunk_data, chunk_hash, file_key)
            
            # Update Redis with chunk hash
            redis_client = await get_redis()
            session_key = f"upload:{chunk_info['upload_id']}"
            session_data = await redis_client.get(session_key)
            
            if session_data:
                session = json.loads(session_data)
                if len(session["chunk_hashes"]) <= chunk_info['chunk_index']:
                    session["chunk_hashes"].extend([None] * (chunk_info['chunk_index'] + 1 - len(session["chunk_hashes"])))
                session["chunk_hashes"][chunk_info['chunk_index']] = chunk_hash
                await redis_client.setex(session_key, 3600, json.dumps(session))
            
            # Clean up temp file
            os.remove(chunk_info['chunk_path'])
            
            # Send completion event
            await self.producer.send('chunk-completed', {
                'upload_id': chunk_info['upload_id'],
                'chunk_index': chunk_info['chunk_index'],
                'chunk_hash': chunk_hash,
                'status': 'success'
            })
            
        except Exception as e:
            # Send error event
            await self.producer.send('chunk-error', {
                'upload_id': chunk_info['upload_id'],
                'chunk_index': chunk_info['chunk_index'],
                'error': str(e)
            })

if __name__ == "__main__":
    processor = ChunkProcessor()
    asyncio.run(processor.start())