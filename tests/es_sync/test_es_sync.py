"""
Tests for Elasticsearch index-database sync.
Verifies that all CRUD operations correctly update the ES index.

These are direct async unit tests — no FastAPI TestClient, no lifespan, no real DB/Redis.
Each test patches search_service on the target module and calls route functions directly.
"""
import pytest
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock
from uuid import uuid4


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def make_mock_file(**overrides):
    """Create a mock file object with reasonable defaults."""
    file = MagicMock()
    file.id = overrides.get("id", uuid4())
    file.user_id = overrides.get("user_id", uuid4())
    file.file_name = overrides.get("file_name", "test.pdf")
    file.file_size = overrides.get("file_size", 1024)
    file.mime_type = overrides.get("mime_type", "application/pdf")
    file.storage_tier = overrides.get("storage_tier", "cache")
    file.folder_id = overrides.get("folder_id", None)
    file.storage_type = overrides.get("storage_type", "single")
    file.storage_key = overrides.get("storage_key", None)
    file.object_path = overrides.get("object_path", "/tmp/nonexistent")
    file.chunk_info = overrides.get("chunk_info", None)
    file.optimized_path = overrides.get("optimized_path", None)
    file.is_deleted = overrides.get("is_deleted", False)
    file.deleted_at = overrides.get("deleted_at", None)
    file.created_at = overrides.get("created_at", datetime.utcnow())
    file.updated_at = overrides.get("updated_at", datetime.utcnow())
    file.file_metadata = overrides.get("file_metadata", None)
    file.encryption_key = overrides.get("encryption_key", None)
    file.content_hash = overrides.get("content_hash", None)
    file.upload_status = overrides.get("upload_status", "completed")
    file.versioning_enabled = overrides.get("versioning_enabled", False)
    file.is_encrypted = overrides.get("is_encrypted", False)
    file.last_accessed = overrides.get("last_accessed", None)
    return file


def make_mock_folder(**overrides):
    """Create a mock folder object."""
    folder = MagicMock()
    folder.id = overrides.get("id", uuid4())
    folder.user_id = overrides.get("user_id", uuid4())
    folder.name = overrides.get("name", "TestFolder")
    folder.parent_id = overrides.get("parent_id", None)
    folder.path = overrides.get("path", "/TestFolder")
    folder.created_at = overrides.get("created_at", datetime.utcnow())
    return folder


def make_mock_user(**overrides):
    """Create a mock user object."""
    user = MagicMock()
    user.id = overrides.get("id", uuid4())
    user.email = overrides.get("email", "test@example.com")
    return user


def make_mock_request():
    """Create a mock Request object."""
    request = MagicMock()
    request.client = MagicMock()
    request.client.host = "127.0.0.1"
    request.headers = {"user-agent": "test"}
    return request


def make_mock_db():
    """Create an AsyncMock DB session."""
    db = AsyncMock()
    db.commit = AsyncMock()
    db.rollback = AsyncMock()
    db.delete = AsyncMock()
    db.add = MagicMock()
    db.refresh = AsyncMock()
    return db


def make_scalars_result(items):
    """Create a mock query result that returns items from scalars().all()."""
    result = MagicMock()
    scalars = MagicMock()
    scalars.all.return_value = items
    result.scalars.return_value = scalars
    result.scalar_one_or_none.return_value = items[0] if items else None
    return result


def make_fetchall_result(rows):
    """Create a mock query result for fetchall()-style tag queries."""
    result = MagicMock()
    result.fetchall.return_value = rows
    return result


# ---------------------------------------------------------------------------
# Test 1: Bulk delete calls ES delete
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@patch("app.routers.files.search_service")
@patch("app.routers.files.audit_logging_service")
@patch("app.routers.files.log_activity", new_callable=AsyncMock)
async def test_bulk_delete_calls_es_delete(mock_log, mock_audit, mock_ss):
    from app.routers.files import bulk_delete_files, BulkDeleteRequest

    mock_ss.connected = True
    mock_ss.delete_file = AsyncMock(return_value=True)
    mock_audit.log_event = AsyncMock()

    files = [make_mock_file(id=uuid4()) for _ in range(3)]
    file_ids = [str(f.id) for f in files]

    db = make_mock_db()
    db.execute = AsyncMock(return_value=make_scalars_result(files))

    user = make_mock_user()
    request = make_mock_request()
    request_data = BulkDeleteRequest(file_ids=file_ids)

    result = await bulk_delete_files(request, request_data, user, db)

    assert result["deleted"] == 3
    assert mock_ss.delete_file.call_count == 3
    for fid in file_ids:
        mock_ss.delete_file.assert_any_call(fid)


# ---------------------------------------------------------------------------
# Test 9: ES failure does not fail request
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@patch("app.routers.files.search_service")
@patch("app.routers.files.audit_logging_service")
@patch("app.routers.files.log_activity", new_callable=AsyncMock)
async def test_es_failure_does_not_fail_request(mock_log, mock_audit, mock_ss):
    from app.routers.files import bulk_delete_files, BulkDeleteRequest

    mock_ss.connected = True
    mock_ss.delete_file = AsyncMock(side_effect=Exception("ES down"))
    mock_audit.log_event = AsyncMock()

    files = [make_mock_file(id=uuid4())]
    file_ids = [str(f.id) for f in files]

    db = make_mock_db()
    db.execute = AsyncMock(return_value=make_scalars_result(files))

    user = make_mock_user()
    request = make_mock_request()
    request_data = BulkDeleteRequest(file_ids=file_ids)

    # Should NOT raise despite ES failure
    result = await bulk_delete_files(request, request_data, user, db)
    assert result["deleted"] == 1


# ---------------------------------------------------------------------------
# Test 10: ES disconnected skips sync
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@patch("app.routers.files.search_service")
@patch("app.routers.files.audit_logging_service")
@patch("app.routers.files.log_activity", new_callable=AsyncMock)
async def test_es_disconnected_skips_sync(mock_log, mock_audit, mock_ss):
    from app.routers.files import bulk_delete_files, BulkDeleteRequest

    mock_ss.connected = False
    mock_ss.delete_file = AsyncMock()
    mock_audit.log_event = AsyncMock()

    files = [make_mock_file(id=uuid4())]
    file_ids = [str(f.id) for f in files]

    db = make_mock_db()
    db.execute = AsyncMock(return_value=make_scalars_result(files))

    user = make_mock_user()
    request = make_mock_request()
    request_data = BulkDeleteRequest(file_ids=file_ids)

    result = await bulk_delete_files(request, request_data, user, db)
    assert result["deleted"] == 1
    mock_ss.delete_file.assert_not_called()


# ---------------------------------------------------------------------------
# Test 7: Tag add calls partial update (not index_file)
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@patch("app.routers.file_analysis.search_service")
async def test_tag_add_calls_partial_update(mock_ss):
    from app.routers.file_analysis import add_file_tag

    mock_ss.connected = True
    mock_ss.update_file_tags = AsyncMock(return_value=True)
    mock_ss.index_file = AsyncMock()  # Should NOT be called

    file_obj = make_mock_file()
    db = make_mock_db()

    # First execute: file ownership check
    file_result = make_scalars_result([file_obj])
    # Second execute: insert tag (commit succeeds)
    insert_result = AsyncMock()
    # Third execute: fetch current tags
    tags_result = make_fetchall_result([("newtag",), ("existing",)])

    db.execute = AsyncMock(side_effect=[file_result, insert_result, tags_result])

    user = make_mock_user(id=file_obj.user_id)
    result = await add_file_tag(str(file_obj.id), "newtag", user, db)

    assert result["success"] is True
    mock_ss.update_file_tags.assert_called_once()
    call_args = mock_ss.update_file_tags.call_args
    assert "newtag" in call_args[0][1]
    mock_ss.index_file.assert_not_called()


# ---------------------------------------------------------------------------
# Test 8: Tag remove calls partial update
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@patch("app.routers.file_analysis.search_service")
async def test_tag_remove_calls_partial_update(mock_ss):
    from app.routers.file_analysis import remove_file_tag

    mock_ss.connected = True
    mock_ss.update_file_tags = AsyncMock(return_value=True)

    file_obj = make_mock_file()
    db = make_mock_db()

    file_result = make_scalars_result([file_obj])
    delete_result = AsyncMock()
    # After removing "oldtag", only "remaining" is left
    tags_result = make_fetchall_result([("remaining",)])

    db.execute = AsyncMock(side_effect=[file_result, delete_result, tags_result])

    user = make_mock_user(id=file_obj.user_id)
    result = await remove_file_tag(str(file_obj.id), "oldtag", user, db)

    assert result["success"] is True
    mock_ss.update_file_tags.assert_called_once()
    call_args = mock_ss.update_file_tags.call_args
    assert call_args[0][1] == ["remaining"]


# ---------------------------------------------------------------------------
# Test 6: Folder update calls ES index_folder
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
@patch("app.routers.folders.search_service")
@patch("app.routers.folders.log_activity", new_callable=AsyncMock)
async def test_folder_update_calls_es_index(mock_log, mock_ss):
    from app.routers.folders import update_folder
    from app.models.schemas import FolderCreate

    mock_ss.connected = True
    mock_ss.index_folder = AsyncMock(return_value=True)

    folder = make_mock_folder(name="OldName", path="/OldName")
    db = make_mock_db()
    db.execute = AsyncMock(return_value=make_scalars_result([folder]))

    user = make_mock_user(id=folder.user_id)
    folder_data = FolderCreate(name="NewName", parent_id=folder.parent_id)

    result = await update_folder(str(folder.id), folder_data, user, db)

    mock_ss.index_folder.assert_called_once()
    call_args = mock_ss.index_folder.call_args[0][0]
    assert call_args["name"] == "NewName"
