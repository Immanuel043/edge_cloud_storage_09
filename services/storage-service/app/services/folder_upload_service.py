"""
Folder Upload Service

Handles batch file uploads with folder structure preservation:
- Path traversal prevention
- Recursive folder creation
- Batch processing
- Transaction management
"""

import json
import logging
import os
import re
import uuid
from datetime import datetime
from pathlib import PurePosixPath
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)


class PathValidationError(Exception):
    """Raised when path validation fails"""

    pass


class FolderUploadService:
    """
    Service for handling folder uploads with security controls

    Security features:
    - Path traversal prevention
    - Maximum folder depth limits
    - Filename sanitization
    - Maximum file count limits
    - Duplicate path detection
    """

    MAX_FOLDER_DEPTH = 10
    MAX_FILES_PER_UPLOAD = 1000
    MAX_PATH_LENGTH = 255
    MAX_FILENAME_LENGTH = 255

    # Allowed characters in paths (alphanumeric, spaces, dashes, underscores, dots)
    SAFE_PATH_PATTERN = re.compile(r"^[\w\s\-\.\/]+$")

    def __init__(self):
        pass

    def validate_path(self, path: str) -> Tuple[bool, Optional[str]]:
        """
        Validate a file path for security

        Args:
            path: Relative path to validate

        Returns:
            Tuple of (is_valid, error_message)

        Raises:
            PathValidationError: If path is invalid or dangerous
        """
        # Remove leading/trailing whitespace
        path = path.strip()

        # Check for empty path
        if not path:
            raise PathValidationError("Path cannot be empty")

        # Check for absolute paths
        if path.startswith("/") or path.startswith("\\"):
            raise PathValidationError("Absolute paths are not allowed")

        # Check for Windows drive letters
        if len(path) >= 2 and path[1] == ":":
            raise PathValidationError("Drive letters are not allowed")

        # Check for path traversal
        if ".." in path:
            raise PathValidationError("Path traversal (..) is not allowed")

        # Normalize path using pathlib
        try:
            normalized = PurePosixPath(path)
            normalized_str = str(normalized)

            # Check if normalization changed the path significantly
            # (could indicate path traversal attempts)
            if ".." in normalized_str or normalized_str.startswith("/"):
                raise PathValidationError("Invalid path detected after normalization")

        except Exception as e:
            raise PathValidationError(f"Path normalization failed: {e}")

        # Check path length
        if len(path) > self.MAX_PATH_LENGTH:
            raise PathValidationError(f"Path too long: {len(path)} (max: {self.MAX_PATH_LENGTH})")

        # Check for null bytes
        if "\x00" in path:
            raise PathValidationError("Null bytes in path are not allowed")

        # Check folder depth
        depth = path.count("/") + path.count("\\")
        if depth > self.MAX_FOLDER_DEPTH:
            raise PathValidationError(
                f"Folder depth {depth} exceeds maximum {self.MAX_FOLDER_DEPTH}"
            )

        # Validate individual path components
        parts = path.replace("\\", "/").split("/")
        for part in parts:
            if not part:  # Skip empty parts
                continue

            # Check part length
            if len(part) > self.MAX_FILENAME_LENGTH:
                raise PathValidationError(
                    f"Path component '{part}' is too long " f"(max: {self.MAX_FILENAME_LENGTH})"
                )

            # Check for reserved names (Windows)
            reserved_names = {
                "CON",
                "PRN",
                "AUX",
                "NUL",
                "COM1",
                "COM2",
                "COM3",
                "COM4",
                "COM5",
                "COM6",
                "COM7",
                "COM8",
                "COM9",
                "LPT1",
                "LPT2",
                "LPT3",
                "LPT4",
                "LPT5",
                "LPT6",
                "LPT7",
                "LPT8",
                "LPT9",
            }
            if part.upper() in reserved_names:
                raise PathValidationError(f"Reserved name '{part}' is not allowed")

        return True, None

    def sanitize_path(self, path: str) -> str:
        """
        Sanitize a path by removing/replacing dangerous characters

        Args:
            path: Path to sanitize

        Returns:
            Sanitized path
        """
        # Replace backslashes with forward slashes
        path = path.replace("\\", "/")

        # Remove leading/trailing slashes and whitespace
        path = path.strip("/ ")

        # Split into components
        parts = [p for p in path.split("/") if p]

        # Sanitize each component
        sanitized_parts = []
        for part in parts:
            # Remove dangerous characters
            safe_part = re.sub(r"[^\w\s\-\.]", "_", part)

            # Remove leading/trailing dots and spaces
            safe_part = safe_part.strip(". ")

            # Ensure not empty
            if not safe_part:
                safe_part = "folder"

            # Truncate if too long
            if len(safe_part) > self.MAX_FILENAME_LENGTH:
                name, ext = os.path.splitext(safe_part)
                safe_part = name[: self.MAX_FILENAME_LENGTH - len(ext) - 1] + ext

            sanitized_parts.append(safe_part)

        return "/".join(sanitized_parts)

    def parse_folder_structure(self, file_paths: List[str]) -> Dict[str, List[str]]:
        """
        Parse folder structure from file paths

        Args:
            file_paths: List of relative file paths

        Returns:
            Dict mapping folder paths to list of files in that folder

        Raises:
            PathValidationError: If validation fails
        """
        # Validate count
        if len(file_paths) > self.MAX_FILES_PER_UPLOAD:
            raise PathValidationError(
                f"Too many files: {len(file_paths)} " f"(max: {self.MAX_FILES_PER_UPLOAD})"
            )

        folder_structure = {}
        seen_paths = set()

        for file_path in file_paths:
            # Validate path
            self.validate_path(file_path)

            # Sanitize path
            safe_path = self.sanitize_path(file_path)

            # Check for duplicates
            if safe_path.lower() in seen_paths:
                logger.warning(f"Duplicate path detected: {safe_path}")
                continue

            seen_paths.add(safe_path.lower())

            # Extract folder path
            parts = safe_path.split("/")
            if len(parts) == 1:
                # File in root folder
                folder_path = ""
                filename = parts[0]
            else:
                # File in subfolder
                folder_path = "/".join(parts[:-1])
                filename = parts[-1]

            # Add to structure
            if folder_path not in folder_structure:
                folder_structure[folder_path] = []

            folder_structure[folder_path].append(filename)

        return folder_structure

    def get_folder_hierarchy(self, folder_structure: Dict[str, List[str]]) -> List[str]:
        """
        Get ordered list of folders to create (parents first)

        Args:
            folder_structure: Folder structure from parse_folder_structure

        Returns:
            Ordered list of folder paths
        """
        # Get all folder paths
        folder_paths = [fp for fp in folder_structure.keys() if fp]

        # Sort by depth (create parents first)
        folder_paths.sort(key=lambda x: x.count("/"))

        return folder_paths

    async def create_folder_session(
        self,
        session_id: str,
        user_id: str,
        root_folder_name: str,
        parent_folder_id: Optional[str],
        total_files: int,
        total_size: int,
        redis_client,
    ) -> Dict:
        """
        Create a folder upload session in Redis

        Args:
            session_id: Session ID
            user_id: User ID
            root_folder_name: Name of root folder
            parent_folder_id: Parent folder ID (or None for root)
            total_files: Total number of files
            total_size: Total size in bytes
            redis_client: Redis client

        Returns:
            Session data dict
        """
        session_data = {
            "session_id": session_id,
            "user_id": user_id,
            "root_folder_name": root_folder_name,
            "parent_folder_id": parent_folder_id,
            "total_files": total_files,
            "total_size": total_size,
            "uploaded_files": 0,
            "failed_files": 0,
            "status": "in_progress",
            "created_folders": {},  # path -> folder_id mapping
            "uploaded_file_ids": [],
            "errors": [],
            "created_at": datetime.utcnow().isoformat(),
        }

        # Store in Redis (24 hour TTL)
        await redis_client.setex(f"folder_upload:{session_id}", 86400, json.dumps(session_data))

        return session_data

    async def get_session(self, session_id: str, redis_client) -> Optional[Dict]:
        """
        Get folder upload session from Redis

        Args:
            session_id: Session ID
            redis_client: Redis client

        Returns:
            Session data dict or None if not found
        """
        session_data = await redis_client.get(f"folder_upload:{session_id}")
        if not session_data:
            return None

        if isinstance(session_data, bytes):
            session_data = session_data.decode("utf-8")

        return json.loads(session_data)

    async def update_session(self, session_id: str, updates: Dict, redis_client) -> None:
        """
        Update folder upload session in Redis

        Args:
            session_id: Session ID
            updates: Dictionary of fields to update
            redis_client: Redis client
        """
        session_data = await self.get_session(session_id, redis_client)
        if not session_data:
            return

        # Update fields
        session_data.update(updates)
        session_data["updated_at"] = datetime.utcnow().isoformat()

        # Save back to Redis
        await redis_client.setex(f"folder_upload:{session_id}", 86400, json.dumps(session_data))

    async def mark_file_uploaded(self, session_id: str, file_id: str, redis_client) -> None:
        """
        Mark a file as successfully uploaded

        Args:
            session_id: Session ID
            file_id: File ID
            redis_client: Redis client
        """
        session_data = await self.get_session(session_id, redis_client)
        if not session_data:
            return

        session_data["uploaded_files"] += 1
        session_data["uploaded_file_ids"].append(file_id)

        await self.update_session(session_id, session_data, redis_client)

    async def mark_file_failed(
        self, session_id: str, file_path: str, error: str, redis_client
    ) -> None:
        """
        Mark a file upload as failed

        Args:
            session_id: Session ID
            file_path: File path that failed
            error: Error message
            redis_client: Redis client
        """
        session_data = await self.get_session(session_id, redis_client)
        if not session_data:
            return

        session_data["failed_files"] += 1
        session_data["errors"].append({"file_path": file_path, "error": error})

        await self.update_session(session_id, session_data, redis_client)

    async def add_created_folder(
        self, session_id: str, folder_path: str, folder_id: str, redis_client
    ) -> None:
        """
        Track a created folder in the session

        Args:
            session_id: Session ID
            folder_path: Relative folder path
            folder_id: Database folder ID
            redis_client: Redis client
        """
        session_data = await self.get_session(session_id, redis_client)
        if not session_data:
            return

        session_data["created_folders"][folder_path] = folder_id

        await self.update_session(session_id, session_data, redis_client)


# Singleton instance
folder_upload_service = FolderUploadService()
