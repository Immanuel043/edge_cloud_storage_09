use crate::error::DataPlaneError;
use crate::storage::{AtomicWriter, WriteOptions};
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use tracing::{debug, instrument};

/// Chunk storage manager
///
/// # Directory Structure
/// ```text
/// storage_root/
///   files/
///     {file_id}/
///       chunks/
///         chunk-0000000000.enc
///         chunk-0000000001.enc
///         chunk-0000000002.enc
///       metadata.json
/// ```
pub struct ChunkStorage {
    storage_root: PathBuf,
    writer: AtomicWriter,
}

impl ChunkStorage {
    /// Create new chunk storage
    pub fn new(storage_root: impl AsRef<Path>, write_options: WriteOptions) -> Self {
        Self {
            storage_root: storage_root.as_ref().to_path_buf(),
            writer: AtomicWriter::new(write_options),
        }
    }

    /// Store encrypted chunk
    ///
    /// # Arguments
    /// * `file_id` - Unique file identifier
    /// * `chunk_index` - Chunk index (0-based)
    /// * `data` - Encrypted chunk data
    ///
    /// # Returns
    /// Path to stored chunk
    #[instrument(skip(self, data), fields(file_id = %file_id, chunk_index = chunk_index, size = data.len()))]
    pub fn store_chunk(
        &mut self,
        file_id: &str,
        chunk_index: u64,
        data: &[u8],
    ) -> Result<PathBuf, DataPlaneError> {
        let chunk_path = self.get_chunk_path(file_id, chunk_index);

        debug!(path = %chunk_path.display(), "Storing chunk");

        self.writer.write_atomic(&chunk_path, data)?;

        debug!("Chunk stored successfully");
        Ok(chunk_path)
    }

    /// Retrieve encrypted chunk
    ///
    /// # Arguments
    /// * `file_id` - Unique file identifier
    /// * `chunk_index` - Chunk index (0-based)
    ///
    /// # Returns
    /// Encrypted chunk data
    #[instrument(skip(self), fields(file_id = %file_id, chunk_index = chunk_index))]
    pub fn retrieve_chunk(
        &self,
        file_id: &str,
        chunk_index: u64,
    ) -> Result<Vec<u8>, DataPlaneError> {
        let chunk_path = self.get_chunk_path(file_id, chunk_index);

        debug!(path = %chunk_path.display(), "Retrieving chunk");

        let mut file = File::open(&chunk_path).map_err(|e| {
            DataPlaneError::InvalidRequest(format!("Chunk not found: {}", e))
        })?;

        let mut data = Vec::new();
        file.read_to_end(&mut data)
            .map_err(|e| DataPlaneError::Io(e))?;

        debug!(size = data.len(), "Chunk retrieved successfully");
        Ok(data)
    }

    /// Delete chunk
    pub fn delete_chunk(&self, file_id: &str, chunk_index: u64) -> Result<(), DataPlaneError> {
        let chunk_path = self.get_chunk_path(file_id, chunk_index);

        debug!(path = %chunk_path.display(), "Deleting chunk");

        fs::remove_file(&chunk_path).map_err(|e| {
            DataPlaneError::InvalidRequest(format!("Failed to delete chunk: {}", e))
        })?;

        Ok(())
    }

    /// Delete all chunks for a file
    pub fn delete_file(&self, file_id: &str) -> Result<(), DataPlaneError> {
        let file_dir = self.get_file_directory(file_id);

        debug!(path = %file_dir.display(), "Deleting file directory");

        if file_dir.exists() {
            fs::remove_dir_all(&file_dir).map_err(|e| {
                DataPlaneError::InvalidRequest(format!("Failed to delete file: {}", e))
            })?;
        }

        Ok(())
    }

    /// Check if chunk exists
    pub fn chunk_exists(&self, file_id: &str, chunk_index: u64) -> bool {
        self.get_chunk_path(file_id, chunk_index).exists()
    }

    /// List all chunks for a file
    pub fn list_chunks(&self, file_id: &str) -> Result<Vec<u64>, DataPlaneError> {
        let chunks_dir = self.get_chunks_directory(file_id);

        if !chunks_dir.exists() {
            return Ok(Vec::new());
        }

        let mut chunk_indices = Vec::new();

        for entry in fs::read_dir(&chunks_dir).map_err(|e| DataPlaneError::Io(e))? {
            let entry = entry.map_err(|e| DataPlaneError::Io(e))?;
            let path = entry.path();

            if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
                if filename.starts_with("chunk-") && filename.ends_with(".enc") {
                    if let Some(index_str) = filename
                        .strip_prefix("chunk-")
                        .and_then(|s| s.strip_suffix(".enc"))
                    {
                        if let Ok(index) = index_str.parse::<u64>() {
                            chunk_indices.push(index);
                        }
                    }
                }
            }
        }

        chunk_indices.sort_unstable();
        Ok(chunk_indices)
    }

    /// Get storage statistics
    pub fn get_stats(&self, file_id: &str) -> Result<StorageStats, DataPlaneError> {
        let chunks = self.list_chunks(file_id)?;
        let file_dir = self.get_file_directory(file_id);

        let mut total_size = 0u64;

        for chunk_index in &chunks {
            let chunk_path = self.get_chunk_path(file_id, *chunk_index);
            if let Ok(metadata) = fs::metadata(&chunk_path) {
                total_size += metadata.len();
            }
        }

        Ok(StorageStats {
            file_id: file_id.to_string(),
            chunk_count: chunks.len(),
            total_size_bytes: total_size,
            storage_path: file_dir,
        })
    }

    /// Store encrypted chunk at an arbitrary target path.
    ///
    /// Used when the caller specifies exactly where the chunk should be written
    /// (e.g., Python tells Rust to write directly to its cache path).
    ///
    /// # Arguments
    /// * `target_path` - Absolute path where the chunk should be written
    /// * `data` - Encrypted chunk data
    ///
    /// # Returns
    /// Path to stored chunk (same as `target_path`)
    #[instrument(skip(self, data), fields(target_path = %target_path.display(), size = data.len()))]
    pub fn store_chunk_at(
        &mut self,
        target_path: &Path,
        data: &[u8],
    ) -> Result<PathBuf, DataPlaneError> {
        debug!(path = %target_path.display(), "Storing chunk at target path");

        self.writer.write_atomic(target_path, data)?;

        debug!("Chunk stored at target path successfully");
        Ok(target_path.to_path_buf())
    }

    /// Finalize upload session (force fsync if using PerSession strategy)
    pub fn finalize_session(&mut self, file_id: &str) -> Result<(), DataPlaneError> {
        let file_dir = self.get_file_directory(file_id);
        self.writer.finalize_session(&file_dir)
    }

    /// Get chunk file path
    fn get_chunk_path(&self, file_id: &str, chunk_index: u64) -> PathBuf {
        self.get_chunks_directory(file_id)
            .join(format!("chunk-{:010}.enc", chunk_index))
    }

    /// Get chunks directory for a file
    fn get_chunks_directory(&self, file_id: &str) -> PathBuf {
        self.get_file_directory(file_id).join("chunks")
    }

    /// Get file directory
    fn get_file_directory(&self, file_id: &str) -> PathBuf {
        self.storage_root.join("files").join(file_id)
    }
}

/// Storage statistics
#[derive(Debug, Clone)]
pub struct StorageStats {
    pub file_id: String,
    pub chunk_count: usize,
    pub total_size_bytes: u64,
    pub storage_path: PathBuf,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_store_and_retrieve_chunk() {
        let temp_dir = TempDir::new().unwrap();
        let mut storage = ChunkStorage::new(temp_dir.path(), WriteOptions::default());

        let data = b"Encrypted chunk data";
        let file_id = "file-123";

        storage.store_chunk(file_id, 0, data).unwrap();

        let retrieved = storage.retrieve_chunk(file_id, 0).unwrap();
        assert_eq!(retrieved, data);
    }

    #[test]
    fn test_store_multiple_chunks() {
        let temp_dir = TempDir::new().unwrap();
        let mut storage = ChunkStorage::new(temp_dir.path(), WriteOptions::default());

        let file_id = "file-456";

        for i in 0..5 {
            let data = format!("Chunk {}", i);
            storage.store_chunk(file_id, i, data.as_bytes()).unwrap();
        }

        for i in 0..5 {
            let data = storage.retrieve_chunk(file_id, i).unwrap();
            assert_eq!(data, format!("Chunk {}", i).as_bytes());
        }
    }

    #[test]
    fn test_chunk_exists() {
        let temp_dir = TempDir::new().unwrap();
        let mut storage = ChunkStorage::new(temp_dir.path(), WriteOptions::default());

        let file_id = "file-789";

        assert!(!storage.chunk_exists(file_id, 0));

        storage.store_chunk(file_id, 0, b"data").unwrap();

        assert!(storage.chunk_exists(file_id, 0));
        assert!(!storage.chunk_exists(file_id, 1));
    }

    #[test]
    fn test_list_chunks() {
        let temp_dir = TempDir::new().unwrap();
        let mut storage = ChunkStorage::new(temp_dir.path(), WriteOptions::default());

        let file_id = "file-list";

        // Store chunks in non-sequential order
        storage.store_chunk(file_id, 2, b"chunk2").unwrap();
        storage.store_chunk(file_id, 0, b"chunk0").unwrap();
        storage.store_chunk(file_id, 1, b"chunk1").unwrap();

        let chunks = storage.list_chunks(file_id).unwrap();

        // Should be sorted
        assert_eq!(chunks, vec![0, 1, 2]);
    }

    #[test]
    fn test_list_chunks_empty() {
        let temp_dir = TempDir::new().unwrap();
        let storage = ChunkStorage::new(temp_dir.path(), WriteOptions::default());

        let chunks = storage.list_chunks("non-existent").unwrap();
        assert!(chunks.is_empty());
    }

    #[test]
    fn test_delete_chunk() {
        let temp_dir = TempDir::new().unwrap();
        let mut storage = ChunkStorage::new(temp_dir.path(), WriteOptions::default());

        let file_id = "file-delete";

        storage.store_chunk(file_id, 0, b"data").unwrap();
        assert!(storage.chunk_exists(file_id, 0));

        storage.delete_chunk(file_id, 0).unwrap();
        assert!(!storage.chunk_exists(file_id, 0));
    }

    #[test]
    fn test_delete_file() {
        let temp_dir = TempDir::new().unwrap();
        let mut storage = ChunkStorage::new(temp_dir.path(), WriteOptions::default());

        let file_id = "file-delete-all";

        storage.store_chunk(file_id, 0, b"chunk0").unwrap();
        storage.store_chunk(file_id, 1, b"chunk1").unwrap();
        storage.store_chunk(file_id, 2, b"chunk2").unwrap();

        storage.delete_file(file_id).unwrap();

        assert!(!storage.chunk_exists(file_id, 0));
        assert!(!storage.chunk_exists(file_id, 1));
        assert!(!storage.chunk_exists(file_id, 2));

        let chunks = storage.list_chunks(file_id).unwrap();
        assert!(chunks.is_empty());
    }

    #[test]
    fn test_get_stats() {
        let temp_dir = TempDir::new().unwrap();
        let mut storage = ChunkStorage::new(temp_dir.path(), WriteOptions::default());

        let file_id = "file-stats";

        storage.store_chunk(file_id, 0, b"12345").unwrap(); // 5 bytes
        storage.store_chunk(file_id, 1, b"123456789").unwrap(); // 9 bytes

        let stats = storage.get_stats(file_id).unwrap();

        assert_eq!(stats.file_id, file_id);
        assert_eq!(stats.chunk_count, 2);
        assert_eq!(stats.total_size_bytes, 14); // 5 + 9
    }

    #[test]
    fn test_retrieve_non_existent_chunk() {
        let temp_dir = TempDir::new().unwrap();
        let storage = ChunkStorage::new(temp_dir.path(), WriteOptions::default());

        let result = storage.retrieve_chunk("non-existent", 0);
        assert!(result.is_err());
    }

    #[test]
    fn test_chunk_path_format() {
        let temp_dir = TempDir::new().unwrap();
        let storage = ChunkStorage::new(temp_dir.path(), WriteOptions::default());

        let path = storage.get_chunk_path("file-123", 42);
        let filename = path.file_name().unwrap().to_str().unwrap();

        assert_eq!(filename, "chunk-0000000042.enc");
    }

    #[test]
    fn test_large_chunk_index() {
        let temp_dir = TempDir::new().unwrap();
        let mut storage = ChunkStorage::new(temp_dir.path(), WriteOptions::default());

        let file_id = "file-large-index";
        let large_index = 9999999999u64;

        storage.store_chunk(file_id, large_index, b"data").unwrap();

        let chunks = storage.list_chunks(file_id).unwrap();
        assert_eq!(chunks, vec![large_index]);
    }

    #[test]
    fn test_store_chunk_at() {
        let temp_dir = TempDir::new().unwrap();
        let mut storage = ChunkStorage::new(temp_dir.path(), WriteOptions::default());

        // Create a custom target path inside the temp directory
        let target_dir = temp_dir.path().join("custom").join("cache").join("ab");
        let target_path = target_dir.join("upload_chunk_0.enc");

        let data = b"Encrypted chunk data at custom path";
        let result = storage.store_chunk_at(&target_path, data);
        assert!(result.is_ok());

        let returned_path = result.unwrap();
        assert_eq!(returned_path, target_path);

        // Verify the file was actually written
        let contents = std::fs::read(&target_path).unwrap();
        assert_eq!(contents, data);
    }

    #[test]
    fn test_finalize_session() {
        let temp_dir = TempDir::new().unwrap();
        let mut storage = ChunkStorage::new(temp_dir.path(), WriteOptions::default());

        let file_id = "file-session";

        storage.store_chunk(file_id, 0, b"data").unwrap();
        storage.finalize_session(file_id).unwrap();

        assert!(storage.chunk_exists(file_id, 0));
    }
}
