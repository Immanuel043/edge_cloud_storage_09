use std::fs::File;
use std::io;
use tracing::{debug, instrument};

/// Fsync strategy for durability vs performance tradeoffs
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FsyncStrategy {
    /// No fsync - fastest, data may be lost on crash
    None,
    /// Fsync per chunk - safest, slowest
    PerChunk,
    /// Fsync per upload session (after all chunks) - balanced
    PerSession,
    /// Fsync periodically (every N chunks) - configurable balance
    Periodic(usize),
}

impl FsyncStrategy {
    /// Parse from string configuration
    pub fn from_str(value: &str) -> Result<Self, String> {
        match value.to_lowercase().as_str() {
            "none" => Ok(Self::None),
            "per-chunk" => Ok(Self::PerChunk),
            "per-session" => Ok(Self::PerSession),
            s if s.starts_with("periodic:") => {
                let n = s.strip_prefix("periodic:")
                    .and_then(|n| n.parse::<usize>().ok())
                    .ok_or_else(|| format!("Invalid periodic value: {}", s))?;
                Ok(Self::Periodic(n))
            }
            _ => Err(format!("Invalid fsync strategy: {}", value)),
        }
    }

    /// Convert to string for configuration
    pub fn as_str(&self) -> String {
        match self {
            Self::None => "none".to_string(),
            Self::PerChunk => "per-chunk".to_string(),
            Self::PerSession => "per-session".to_string(),
            Self::Periodic(n) => format!("periodic:{}", n),
        }
    }
}

impl Default for FsyncStrategy {
    /// Default: PerSession (balanced durability and performance)
    fn default() -> Self {
        Self::PerSession
    }
}

/// Fsync mode tracker for deciding when to fsync
pub struct FsyncMode {
    strategy: FsyncStrategy,
    chunk_count: usize,
}

impl FsyncMode {
    pub fn new(strategy: FsyncStrategy) -> Self {
        Self {
            strategy,
            chunk_count: 0,
        }
    }

    /// Check if fsync should be performed after this chunk
    pub fn should_fsync(&mut self) -> bool {
        self.chunk_count += 1;

        match self.strategy {
            FsyncStrategy::None => false,
            FsyncStrategy::PerChunk => true,
            FsyncStrategy::PerSession => false, // Will fsync at end
            FsyncStrategy::Periodic(n) => self.chunk_count % n == 0,
        }
    }

    /// Force fsync (for session end)
    pub fn force_fsync(&self) -> bool {
        !matches!(self.strategy, FsyncStrategy::None)
    }

    /// Reset chunk counter (for new session)
    pub fn reset(&mut self) {
        self.chunk_count = 0;
    }

    /// Get current strategy
    pub fn strategy(&self) -> FsyncStrategy {
        self.strategy
    }
}

/// Perform fsync on file with error handling
#[instrument(skip(file))]
pub fn fsync_file(file: &File) -> io::Result<()> {
    debug!("Performing fsync");
    file.sync_all()?;
    debug!("Fsync completed");
    Ok(())
}

/// Perform fsync on directory (for metadata durability)
#[instrument(skip(dir))]
pub fn fsync_directory(dir: &File) -> io::Result<()> {
    debug!("Performing directory fsync");
    dir.sync_all()?;
    debug!("Directory fsync completed");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_strategy_from_str() {
        assert_eq!(
            FsyncStrategy::from_str("none").unwrap(),
            FsyncStrategy::None
        );
        assert_eq!(
            FsyncStrategy::from_str("per-chunk").unwrap(),
            FsyncStrategy::PerChunk
        );
        assert_eq!(
            FsyncStrategy::from_str("per-session").unwrap(),
            FsyncStrategy::PerSession
        );
        assert_eq!(
            FsyncStrategy::from_str("periodic:10").unwrap(),
            FsyncStrategy::Periodic(10)
        );
    }

    #[test]
    fn test_strategy_from_str_case_insensitive() {
        assert_eq!(
            FsyncStrategy::from_str("NONE").unwrap(),
            FsyncStrategy::None
        );
        assert_eq!(
            FsyncStrategy::from_str("Per-Chunk").unwrap(),
            FsyncStrategy::PerChunk
        );
    }

    #[test]
    fn test_strategy_from_str_invalid() {
        assert!(FsyncStrategy::from_str("invalid").is_err());
        assert!(FsyncStrategy::from_str("periodic:abc").is_err());
        assert!(FsyncStrategy::from_str("periodic:").is_err());
    }

    #[test]
    fn test_strategy_as_str() {
        assert_eq!(FsyncStrategy::None.as_str(), "none");
        assert_eq!(FsyncStrategy::PerChunk.as_str(), "per-chunk");
        assert_eq!(FsyncStrategy::PerSession.as_str(), "per-session");
        assert_eq!(FsyncStrategy::Periodic(5).as_str(), "periodic:5");
    }

    #[test]
    fn test_default_strategy() {
        assert_eq!(FsyncStrategy::default(), FsyncStrategy::PerSession);
    }

    #[test]
    fn test_fsync_mode_none() {
        let mut mode = FsyncMode::new(FsyncStrategy::None);

        assert!(!mode.should_fsync());
        assert!(!mode.should_fsync());
        assert!(!mode.should_fsync());
    }

    #[test]
    fn test_fsync_mode_per_chunk() {
        let mut mode = FsyncMode::new(FsyncStrategy::PerChunk);

        assert!(mode.should_fsync());
        assert!(mode.should_fsync());
        assert!(mode.should_fsync());
    }

    #[test]
    fn test_fsync_mode_per_session() {
        let mut mode = FsyncMode::new(FsyncStrategy::PerSession);

        // Should not fsync during chunks
        assert!(!mode.should_fsync());
        assert!(!mode.should_fsync());
        assert!(!mode.should_fsync());

        // But should force fsync at end
        assert!(mode.force_fsync());
    }

    #[test]
    fn test_fsync_mode_periodic() {
        let mut mode = FsyncMode::new(FsyncStrategy::Periodic(3));

        // Chunk 1: no
        assert!(!mode.should_fsync());
        // Chunk 2: no
        assert!(!mode.should_fsync());
        // Chunk 3: yes (every 3rd)
        assert!(mode.should_fsync());
        // Chunk 4: no
        assert!(!mode.should_fsync());
        // Chunk 5: no
        assert!(!mode.should_fsync());
        // Chunk 6: yes (every 3rd)
        assert!(mode.should_fsync());
    }

    #[test]
    fn test_fsync_mode_reset() {
        let mut mode = FsyncMode::new(FsyncStrategy::Periodic(2));

        assert!(!mode.should_fsync()); // Chunk 1
        assert!(mode.should_fsync());  // Chunk 2: fsync

        mode.reset();

        assert!(!mode.should_fsync()); // Chunk 1 (after reset)
        assert!(mode.should_fsync());  // Chunk 2: fsync
    }

    #[test]
    fn test_force_fsync() {
        let mode_none = FsyncMode::new(FsyncStrategy::None);
        let mode_session = FsyncMode::new(FsyncStrategy::PerSession);
        let mode_chunk = FsyncMode::new(FsyncStrategy::PerChunk);

        assert!(!mode_none.force_fsync());
        assert!(mode_session.force_fsync());
        assert!(mode_chunk.force_fsync());
    }

    #[test]
    fn test_strategy_getter() {
        let mode = FsyncMode::new(FsyncStrategy::Periodic(5));
        assert_eq!(mode.strategy(), FsyncStrategy::Periodic(5));
    }
}
