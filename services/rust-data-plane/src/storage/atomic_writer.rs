use crate::error::DataPlaneError;
use crate::storage::fsync_strategy::{fsync_directory, fsync_file, FsyncMode, FsyncStrategy};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use tracing::{debug, instrument, warn};
use uuid::Uuid;

/// Write options for atomic operations
#[derive(Debug, Clone)]
pub struct WriteOptions {
    /// Fsync strategy
    pub fsync_strategy: FsyncStrategy,
    /// Create parent directories if missing
    pub create_dirs: bool,
    /// File permissions (Unix only)
    #[cfg(unix)]
    pub mode: Option<u32>,
}

impl Default for WriteOptions {
    fn default() -> Self {
        Self {
            fsync_strategy: FsyncStrategy::PerSession,
            create_dirs: true,
            #[cfg(unix)]
            mode: Some(0o644),
        }
    }
}

/// Atomic file writer with crash safety
///
/// # Strategy
/// 1. Write to temporary file (.tmp-{uuid})
/// 2. Optional fsync on temp file
/// 3. Rename to final path (atomic operation)
/// 4. Optional fsync on parent directory (metadata durability)
///
/// # Crash Safety
/// - If crash during write: temp file left behind (cleaned up later)
/// - If crash after rename: final file is complete and durable
/// - No partial writes visible to readers
pub struct AtomicWriter {
    options: WriteOptions,
    fsync_mode: FsyncMode,
}

impl AtomicWriter {
    pub fn new(options: WriteOptions) -> Self {
        let fsync_mode = FsyncMode::new(options.fsync_strategy);
        Self {
            options,
            fsync_mode,
        }
    }

    /// Write data atomically to file
    ///
    /// # Arguments
    /// * `path` - Final file path
    /// * `data` - Data to write
    ///
    /// # Returns
    /// Ok(()) on success
    #[instrument(skip(self, data), fields(path = %path.as_ref().display(), size = data.len()))]
    pub fn write_atomic(&mut self, path: impl AsRef<Path>, data: &[u8]) -> Result<(), DataPlaneError> {
        let path = path.as_ref();

        // Create parent directories if needed
        if self.options.create_dirs {
            if let Some(parent) = path.parent() {
                fs::create_dir_all(parent).map_err(|e| {
                    DataPlaneError::Io(io::Error::new(
                        e.kind(),
                        format!("Failed to create parent directory: {}", e),
                    ))
                })?;
            }
        }

        // Generate temporary file path
        let temp_path = self.generate_temp_path(path);

        debug!(
            temp_path = %temp_path.display(),
            "Writing to temporary file"
        );

        // Write to temporary file
        let mut temp_file = OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(&temp_path)
            .map_err(|e| DataPlaneError::Io(e))?;

        // Set permissions (Unix only)
        #[cfg(unix)]
        if let Some(mode) = self.options.mode {
            use std::os::unix::fs::PermissionsExt;
            let permissions = std::fs::Permissions::from_mode(mode);
            fs::set_permissions(&temp_path, permissions)
                .map_err(|e| DataPlaneError::Io(e))?;
        }

        temp_file.write_all(data).map_err(|e| DataPlaneError::Io(e))?;

        // Fsync temp file if strategy requires (PerSession defers to finalize_session)
        let do_fsync = self.fsync_mode.should_fsync();
        if do_fsync {
            fsync_file(&temp_file).map_err(|e| DataPlaneError::Io(e))?;
        }

        // Close temp file explicitly
        drop(temp_file);

        debug!(
            final_path = %path.display(),
            "Renaming to final path (atomic)"
        );

        // Atomic rename
        fs::rename(&temp_path, path).map_err(|e| {
            // Clean up temp file on rename failure
            let _ = fs::remove_file(&temp_path);
            DataPlaneError::Io(e)
        })?;

        // Fsync parent directory for metadata durability
        if do_fsync {
            if let Some(parent) = path.parent() {
                if let Ok(dir) = File::open(parent) {
                    if let Err(e) = fsync_directory(&dir) {
                        warn!(error = %e, "Failed to fsync parent directory");
                    }
                }
            }
        }

        debug!("Atomic write completed successfully");
        Ok(())
    }

    /// Append data to existing file (non-atomic for efficiency)
    ///
    /// Use for sequential chunk writes where atomicity per chunk is not needed.
    #[instrument(skip(self, data), fields(path = %path.as_ref().display(), size = data.len()))]
    pub fn append(&mut self, path: impl AsRef<Path>, data: &[u8]) -> Result<(), DataPlaneError> {
        let path = path.as_ref();

        let mut file = OpenOptions::new()
            .write(true)
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| DataPlaneError::Io(e))?;

        file.write_all(data).map_err(|e| DataPlaneError::Io(e))?;

        // Fsync if strategy requires
        if self.fsync_mode.should_fsync() {
            fsync_file(&file).map_err(|e| DataPlaneError::Io(e))?;
        }

        Ok(())
    }

    /// Finalize session (force fsync for PerSession strategy)
    pub fn finalize_session(&mut self, path: impl AsRef<Path>) -> Result<(), DataPlaneError> {
        if self.fsync_mode.force_fsync() {
            let file = File::open(path.as_ref()).map_err(|e| DataPlaneError::Io(e))?;
            fsync_file(&file).map_err(|e| DataPlaneError::Io(e))?;
        }

        self.fsync_mode.reset();
        Ok(())
    }

    /// Generate temporary file path
    fn generate_temp_path(&self, path: &Path) -> PathBuf {
        let parent = path.parent().unwrap_or_else(|| Path::new("."));
        let filename = path.file_name().unwrap_or_else(|| std::ffi::OsStr::new("file"));
        let temp_name = format!(".tmp-{}-{}", Uuid::new_v4(), filename.to_string_lossy());
        parent.join(temp_name)
    }

    /// Clean up stale temp files in directory
    pub fn cleanup_temp_files(dir: impl AsRef<Path>) -> io::Result<usize> {
        let dir = dir.as_ref();
        let mut cleaned = 0;

        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let path = entry.path();

            if let Some(filename) = path.file_name().and_then(|n| n.to_str()) {
                if filename.starts_with(".tmp-") {
                    debug!(temp_file = %path.display(), "Removing stale temp file");
                    fs::remove_file(&path)?;
                    cleaned += 1;
                }
            }
        }

        Ok(cleaned)
    }
}

impl Default for AtomicWriter {
    fn default() -> Self {
        Self::new(WriteOptions::default())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn test_atomic_write() {
        let temp_dir = TempDir::new().unwrap();
        let file_path = temp_dir.path().join("test.txt");

        let mut writer = AtomicWriter::default();
        let data = b"Hello, atomic world!";

        writer.write_atomic(&file_path, data).unwrap();

        let read_data = fs::read(&file_path).unwrap();
        assert_eq!(read_data, data);
    }

    #[test]
    fn test_atomic_write_creates_parent_dirs() {
        let temp_dir = TempDir::new().unwrap();
        let file_path = temp_dir.path().join("subdir").join("test.txt");

        let mut writer = AtomicWriter::default();
        writer.write_atomic(&file_path, b"test").unwrap();

        assert!(file_path.exists());
    }

    #[test]
    fn test_atomic_write_overwrites_existing() {
        let temp_dir = TempDir::new().unwrap();
        let file_path = temp_dir.path().join("test.txt");

        let mut writer = AtomicWriter::default();

        // Write initial data
        writer.write_atomic(&file_path, b"old data").unwrap();
        assert_eq!(fs::read(&file_path).unwrap(), b"old data");

        // Overwrite with new data
        writer.write_atomic(&file_path, b"new data").unwrap();
        assert_eq!(fs::read(&file_path).unwrap(), b"new data");
    }

    #[test]
    fn test_append() {
        let temp_dir = TempDir::new().unwrap();
        let file_path = temp_dir.path().join("test.txt");

        let mut writer = AtomicWriter::default();

        writer.append(&file_path, b"Hello ").unwrap();
        writer.append(&file_path, b"World!").unwrap();

        let data = fs::read(&file_path).unwrap();
        assert_eq!(data, b"Hello World!");
    }

    #[test]
    fn test_fsync_strategy_none() {
        let temp_dir = TempDir::new().unwrap();
        let file_path = temp_dir.path().join("test.txt");

        let options = WriteOptions {
            fsync_strategy: FsyncStrategy::None,
            ..Default::default()
        };

        let mut writer = AtomicWriter::new(options);
        writer.write_atomic(&file_path, b"test").unwrap();

        assert!(file_path.exists());
    }

    #[test]
    fn test_fsync_strategy_per_chunk() {
        let temp_dir = TempDir::new().unwrap();
        let file_path = temp_dir.path().join("test.txt");

        let options = WriteOptions {
            fsync_strategy: FsyncStrategy::PerChunk,
            ..Default::default()
        };

        let mut writer = AtomicWriter::new(options);
        writer.append(&file_path, b"chunk1").unwrap();
        writer.append(&file_path, b"chunk2").unwrap();

        assert_eq!(fs::read(&file_path).unwrap(), b"chunk1chunk2");
    }

    #[test]
    fn test_finalize_session() {
        let temp_dir = TempDir::new().unwrap();
        let file_path = temp_dir.path().join("test.txt");

        let mut writer = AtomicWriter::default();

        writer.append(&file_path, b"data").unwrap();
        writer.finalize_session(&file_path).unwrap();

        assert!(file_path.exists());
    }

    #[test]
    fn test_cleanup_temp_files() {
        let temp_dir = TempDir::new().unwrap();

        // Create some temp files
        fs::write(temp_dir.path().join(".tmp-abc-file1.txt"), b"test").unwrap();
        fs::write(temp_dir.path().join(".tmp-def-file2.txt"), b"test").unwrap();
        fs::write(temp_dir.path().join("normal-file.txt"), b"test").unwrap();

        let cleaned = AtomicWriter::cleanup_temp_files(temp_dir.path()).unwrap();

        assert_eq!(cleaned, 2);
        assert!(temp_dir.path().join("normal-file.txt").exists());
        assert!(!temp_dir.path().join(".tmp-abc-file1.txt").exists());
        assert!(!temp_dir.path().join(".tmp-def-file2.txt").exists());
    }

    #[test]
    fn test_temp_path_generation() {
        let writer = AtomicWriter::default();
        let path = PathBuf::from("/data/files/test.txt");
        let temp_path = writer.generate_temp_path(&path);

        assert!(temp_path.starts_with("/data/files"));
        let filename = temp_path.file_name().unwrap().to_str().unwrap();
        assert!(filename.starts_with(".tmp-"));
        assert!(filename.contains("test.txt"));
    }

    #[test]
    fn test_large_file() {
        let temp_dir = TempDir::new().unwrap();
        let file_path = temp_dir.path().join("large.bin");

        let data = vec![0u8; 10 * 1024 * 1024]; // 10MB

        let mut writer = AtomicWriter::default();
        writer.write_atomic(&file_path, &data).unwrap();

        assert_eq!(fs::metadata(&file_path).unwrap().len(), 10 * 1024 * 1024);
    }
}
