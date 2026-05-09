import asyncio
import hashlib
import json
import os
import shutil
from datetime import datetime
from typing import Dict, List, Optional

import aiofiles
import aiohttp
import boto3
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from ..config import settings
from ..database import redis_client
from ..models.database import ActivityLog, Object


class BackupService:
    """Production-grade Backup Service for Edge Cloud"""

    def __init__(self):
        self.s3_client = None  # lazy init
        self.backup_root = settings.BACKUP_PATH

    # =============================
    # 🔹 Helpers
    # =============================
    def _sha256_file(self, file_path: str) -> str:
        sha = hashlib.sha256()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                sha.update(chunk)
        return sha.hexdigest()

    async def _save_local_version(self, object_id: str, data: bytes) -> str:
        backup_dir = os.path.join(self.backup_root, str(object_id))
        os.makedirs(backup_dir, exist_ok=True)

        version_name = datetime.utcnow().strftime("%Y%m%d%H%M%S")
        local_backup = os.path.join(backup_dir, f"{version_name}.bak")

        async with aiofiles.open(local_backup, "wb") as f:
            await f.write(data)

        return local_backup

    def _get_s3_client(self):
        if not settings.BACKUP_S3_ENABLED:
            return None
        if not self.s3_client:
            self.s3_client = boto3.client(
                "s3",
                aws_access_key_id=settings.AWS_ACCESS_KEY,
                aws_secret_access_key=settings.AWS_SECRET_KEY,
            )
        return self.s3_client

    # =============================
    # 🔹 Strategy Resolver
    # =============================
    def resolve_strategy(
        self, user_strategy: str, user=None, db: Optional[AsyncSession] = None
    ) -> str:
        """
        Resolve strategy against global config.
        Logs fallbacks when global settings disable parts of the strategy.
        NOTE: Caller should commit db after calling if logging is used.
        """
        strategy = user_strategy or "local"
        effective_strategy = strategy

        # Node fallback
        if "node" in strategy and not settings.BACKUP_NODE_URL:
            effective_strategy = effective_strategy.replace("+node", "")
            if user and db:
                db.add(
                    ActivityLog(
                        user_id=user.id,
                        action="backup_strategy_fallback",
                        meta_data={
                            "requested": strategy,
                            "reason": "Node disabled globally",
                            "effective": effective_strategy,
                        },
                    )
                )

        # S3 fallback
        if "s3" in strategy and not settings.BACKUP_S3_ENABLED:
            effective_strategy = effective_strategy.replace("+s3", "")
            if user and db:
                db.add(
                    ActivityLog(
                        user_id=user.id,
                        action="backup_strategy_fallback",
                        meta_data={
                            "requested": strategy,
                            "reason": "S3 disabled globally",
                            "effective": effective_strategy,
                        },
                    )
                )

        if not effective_strategy or effective_strategy == "+":
            effective_strategy = "local"

        return effective_strategy

    # =============================
    # 🔹 Local-disk content-addressed backup
    # =============================
    @staticmethod
    def _copy_blob_atomic_sync(src: str, dst: str) -> None:
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        tmp = dst + ".tmp"
        try:
            with open(src, "rb") as fin, open(tmp, "wb") as fout:
                shutil.copyfileobj(fin, fout, length=1024 * 1024)
            os.replace(tmp, dst)
        except BaseException:
            try:
                os.unlink(tmp)
            except FileNotFoundError:
                pass
            raise

    async def backup_to_local_disk(self, obj: Object) -> str:
        """Content-addressed local-disk backup of a single Object row.

        Layout: ``{BACKUP_PATH}/<sha256[:2]>/<sha256>.enc`` — sharded by the
        first two hex chars of `content_hash`, deduplicating blobs that share
        content across rows.

        Idempotent: if the destination already exists with matching size,
        no copy is performed.

        Returns a string suitable for `objects.backup_location`:
          - ``"inline:db"`` for inline-stored rows (no separate file to back up)
          - ``"local:<shard>/<hash>.enc"`` for `single`-storage rows

        Raises:
          FileNotFoundError: source blob is missing on disk (worker maps to
            ``backup_status='source_missing'``).
          NotImplementedError: storage_type other than `inline`/`single` —
            CAS and chunked rows need a CAS-block-aware backup path that is
            out of scope for this MVP.
          ValueError: row is malformed (e.g. missing content_hash).
        """
        if obj.storage_type == "inline":
            return "inline:db"

        if obj.storage_type != "single":
            raise NotImplementedError(
                f"local-disk backup not supported for storage_type={obj.storage_type!r}"
            )

        if not obj.object_path:
            raise ValueError(f"object {obj.id} has no object_path")
        if not obj.content_hash:
            raise ValueError(f"object {obj.id} has no content_hash; cannot content-address backup")

        src = obj.object_path
        if not os.path.exists(src):
            raise FileNotFoundError(src)

        shard = obj.content_hash[:2]
        dst_rel = os.path.join(shard, f"{obj.content_hash}.enc")
        dst = os.path.join(self.backup_root, dst_rel)

        try:
            if os.path.exists(dst) and os.path.getsize(dst) == os.path.getsize(src):
                return f"local:{dst_rel}"
        except OSError:
            pass

        await asyncio.to_thread(self._copy_blob_atomic_sync, src, dst)
        return f"local:{dst_rel}"

    # =============================
    # 🔹 Backup Methods
    # =============================
    async def backup_to_s3(self, file_path: str, s3_key: str) -> bool:
        client = self._get_s3_client()
        if not client:
            return False
        try:
            with open(file_path, "rb") as f:
                client.upload_fileobj(f, settings.BACKUP_S3_BUCKET, s3_key)
            return True
        except Exception as e:
            print(f"S3 backup failed: {e}")
            return False

    async def backup_to_node(self, file_data: bytes, file_id: str, node_url: str) -> bool:
        try:
            async with aiohttp.ClientSession() as session:
                async with session.post(f"{node_url}/backup/{file_id}", data=file_data) as response:
                    return response.status == 200
        except Exception as e:
            print(f"Node backup failed: {e}")
            return False

    async def backup_object(self, object_id: str, chunks: List[Dict]) -> str:
        """Full backup of an object (concatenated raw chunk data)."""
        full_data = b""
        for chunk_info in chunks:
            meta = await redis_client.get(f"chunk:{chunk_info['hash']}")
            if not meta:
                raise HTTPException(404, f"Chunk metadata missing for {chunk_info['hash']}")
            meta_j = json.loads(meta)

            async with aiofiles.open(meta_j["path"], "rb") as f:
                raw_bytes = await f.read()
            full_data += raw_bytes

        local_backup = await self._save_local_version(object_id, full_data)

        client = self._get_s3_client()
        if client:
            await self.backup_to_s3(
                local_backup, f"backups/{object_id}/{os.path.basename(local_backup)}"
            )

        if settings.BACKUP_NODE_URL:
            await self.backup_to_node(full_data, object_id, settings.BACKUP_NODE_URL)

        return local_backup

    async def backup_incremental(self, object_id: str, chunks: List[Dict]) -> List[str]:
        backed_up = []
        for chunk_info in chunks:
            if await redis_client.exists(f"backup:chunk:{chunk_info['hash']}"):
                continue

            meta = await redis_client.get(f"chunk:{chunk_info['hash']}")
            if not meta:
                continue
            meta_j = json.loads(meta)

            async with aiofiles.open(meta_j["path"], "rb") as f:
                raw_bytes = await f.read()

            chunk_path = await self._save_local_version(chunk_info["hash"], raw_bytes)
            backed_up.append(chunk_path)

            client = self._get_s3_client()
            if client:
                await self.backup_to_s3(chunk_path, f"backups/chunks/{chunk_info['hash']}.bak")
            if settings.BACKUP_NODE_URL:
                await self.backup_to_node(raw_bytes, chunk_info["hash"], settings.BACKUP_NODE_URL)

            await redis_client.set(f"backup:chunk:{chunk_info['hash']}", "1")

        return backed_up

    # =============================
    # 🔹 Restore Methods
    # =============================
    async def restore_object(self, object_id: str, version: Optional[str] = None) -> Optional[str]:
        backup_dir = os.path.join(self.backup_root, str(object_id))
        if not os.path.exists(backup_dir):
            return None

        versions = sorted(os.listdir(backup_dir))
        if not versions:
            return None

        chosen_version = version or versions[-1]
        restore_file = os.path.join(backup_dir, chosen_version)

        if os.path.exists(restore_file):
            return restore_file

        client = self._get_s3_client()
        if client:
            try:
                with open(restore_file, "wb") as f:
                    client.download_fileobj(
                        settings.BACKUP_S3_BUCKET, f"backups/{object_id}/{chosen_version}", f
                    )
                return restore_file
            except Exception as e:
                print(f"S3 restore failed: {e}")

        return None

    # =============================
    # 🔹 Retention
    # =============================
    async def enforce_retention(self, object_id: str, max_versions: int = 5):
        backup_dir = os.path.join(self.backup_root, str(object_id))
        if not os.path.exists(backup_dir):
            return

        versions = sorted(os.listdir(backup_dir))
        while len(versions) > max_versions:
            old_version = versions.pop(0)
            try:
                os.remove(os.path.join(backup_dir, old_version))
            except Exception:
                pass


backup_service = BackupService()
