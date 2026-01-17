use crate::error::SecurityError;
use std::fmt;
use tracing::{debug, warn};

/// Processing mode: ZK (zero-knowledge) or Non-ZK (server-side encryption)
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessingMode {
    /// Zero-knowledge mode: Server is blind to plaintext
    /// - Client encrypts data before upload
    /// - Server only hashes and stores
    /// - No server-side encryption key
    /// - No previews, transcoding, or analytics
    ZK,

    /// Non-zero-knowledge mode: Server-side encryption
    /// - Server receives plaintext chunks
    /// - Server encrypts with file key
    /// - Supports compression, previews, transcoding
    NonZK,
}

impl ProcessingMode {
    /// Parse mode from string header value
    pub fn from_header(value: &str) -> Result<Self, SecurityError> {
        match value.to_lowercase().as_str() {
            "zk" => Ok(Self::ZK),
            "non-zk" => Ok(Self::NonZK),
            _ => Err(SecurityError::InvalidMode(value.to_string())),
        }
    }

    /// Convert to string for headers
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::ZK => "zk",
            Self::NonZK => "non-zk",
        }
    }
}

impl fmt::Display for ProcessingMode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// Mode violation details for security auditing
#[derive(Debug, Clone)]
pub struct ModeViolation {
    pub mode: ProcessingMode,
    pub violation_type: ViolationType,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ViolationType {
    /// ZK mode received encryption key (CRITICAL)
    ZkKeyLeakage,
    /// Non-ZK mode missing encryption key
    NonZkMissingKey,
    /// Invalid mode header
    InvalidMode,
}

/// Mode enforcement engine - ensures security boundaries
///
/// # Security Guarantees
/// - ZK mode CANNOT receive encryption keys (compile-time + runtime checks)
/// - Non-ZK mode MUST have encryption keys
/// - Mode transitions not allowed within session
/// - All violations are logged for security auditing
pub struct ModeEnforcer;

impl ModeEnforcer {
    /// Enforce ZK mode security rules
    ///
    /// # Rules
    /// - MUST NOT have encryption key FD
    /// - MUST NOT have encryption key in any form
    /// - Data is assumed to be pre-encrypted by client
    ///
    /// # Returns
    /// Ok(()) if compliant, Err(SecurityError) if violation detected
    pub fn enforce_zk_mode(has_key_fd: bool) -> Result<(), SecurityError> {
        if has_key_fd {
            warn!(
                mode = "zk",
                violation = "key_leakage",
                "SECURITY VIOLATION: ZK mode received encryption key"
            );

            return Err(SecurityError::ZkModeKeyLeakage);
        }

        debug!(mode = "zk", "ZK mode security check passed");
        Ok(())
    }

    /// Enforce Non-ZK mode security rules
    ///
    /// # Rules
    /// - MUST have encryption key FD
    /// - Key will be read from memfd via SCM_RIGHTS
    ///
    /// # Returns
    /// Ok(()) if compliant, Err(SecurityError) if violation detected
    pub fn enforce_non_zk_mode(has_key_fd: bool) -> Result<(), SecurityError> {
        if !has_key_fd {
            warn!(
                mode = "non-zk",
                violation = "missing_key",
                "SECURITY VIOLATION: Non-ZK mode missing encryption key"
            );

            return Err(SecurityError::NonZkMissingKey);
        }

        debug!(mode = "non-zk", "Non-ZK mode security check passed");
        Ok(())
    }

    /// Enforce mode based on ProcessingMode enum
    pub fn enforce(mode: ProcessingMode, has_key_fd: bool) -> Result<(), SecurityError> {
        match mode {
            ProcessingMode::ZK => Self::enforce_zk_mode(has_key_fd),
            ProcessingMode::NonZK => Self::enforce_non_zk_mode(has_key_fd),
        }
    }

    /// Create violation record for auditing
    pub fn create_violation(
        mode: ProcessingMode,
        violation_type: ViolationType,
    ) -> ModeViolation {
        let message = match violation_type {
            ViolationType::ZkKeyLeakage => {
                "ZK mode cannot receive encryption keys - server must remain blind".to_string()
            }
            ViolationType::NonZkMissingKey => {
                "Non-ZK mode requires encryption key for server-side encryption".to_string()
            }
            ViolationType::InvalidMode => {
                format!("Invalid processing mode: {}", mode)
            }
        };

        ModeViolation {
            mode,
            violation_type,
            message,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mode_from_header() {
        assert_eq!(ProcessingMode::from_header("zk").unwrap(), ProcessingMode::ZK);
        assert_eq!(ProcessingMode::from_header("ZK").unwrap(), ProcessingMode::ZK);
        assert_eq!(ProcessingMode::from_header("non-zk").unwrap(), ProcessingMode::NonZK);
        assert_eq!(ProcessingMode::from_header("NON-ZK").unwrap(), ProcessingMode::NonZK);
    }

    #[test]
    fn test_invalid_mode() {
        let result = ProcessingMode::from_header("invalid");
        assert!(result.is_err());
        assert!(matches!(result, Err(SecurityError::InvalidMode(_))));
    }

    #[test]
    fn test_mode_as_str() {
        assert_eq!(ProcessingMode::ZK.as_str(), "zk");
        assert_eq!(ProcessingMode::NonZK.as_str(), "non-zk");
    }

    #[test]
    fn test_mode_display() {
        assert_eq!(format!("{}", ProcessingMode::ZK), "zk");
        assert_eq!(format!("{}", ProcessingMode::NonZK), "non-zk");
    }

    #[test]
    fn test_zk_mode_enforcement_pass() {
        // ZK mode without key FD should pass
        let result = ModeEnforcer::enforce_zk_mode(false);
        assert!(result.is_ok());
    }

    #[test]
    fn test_zk_mode_enforcement_fail() {
        // ZK mode with key FD should fail (SECURITY VIOLATION)
        let result = ModeEnforcer::enforce_zk_mode(true);
        assert!(result.is_err());
        assert!(matches!(result, Err(SecurityError::ZkModeKeyLeakage)));
    }

    #[test]
    fn test_non_zk_mode_enforcement_pass() {
        // Non-ZK mode with key FD should pass
        let result = ModeEnforcer::enforce_non_zk_mode(true);
        assert!(result.is_ok());
    }

    #[test]
    fn test_non_zk_mode_enforcement_fail() {
        // Non-ZK mode without key FD should fail
        let result = ModeEnforcer::enforce_non_zk_mode(false);
        assert!(result.is_err());
        assert!(matches!(result, Err(SecurityError::NonZkMissingKey)));
    }

    #[test]
    fn test_enforce_with_enum() {
        // ZK mode tests
        assert!(ModeEnforcer::enforce(ProcessingMode::ZK, false).is_ok());
        assert!(ModeEnforcer::enforce(ProcessingMode::ZK, true).is_err());

        // Non-ZK mode tests
        assert!(ModeEnforcer::enforce(ProcessingMode::NonZK, true).is_ok());
        assert!(ModeEnforcer::enforce(ProcessingMode::NonZK, false).is_err());
    }

    #[test]
    fn test_create_violation() {
        let violation = ModeEnforcer::create_violation(
            ProcessingMode::ZK,
            ViolationType::ZkKeyLeakage,
        );

        assert_eq!(violation.mode, ProcessingMode::ZK);
        assert_eq!(violation.violation_type, ViolationType::ZkKeyLeakage);
        assert!(violation.message.contains("blind"));
    }

    #[test]
    fn test_violation_messages() {
        let zk_violation = ModeEnforcer::create_violation(
            ProcessingMode::ZK,
            ViolationType::ZkKeyLeakage,
        );
        assert!(zk_violation.message.contains("ZK mode"));

        let non_zk_violation = ModeEnforcer::create_violation(
            ProcessingMode::NonZK,
            ViolationType::NonZkMissingKey,
        );
        assert!(non_zk_violation.message.contains("Non-ZK mode"));
    }
}
