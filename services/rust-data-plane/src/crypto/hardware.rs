use tracing::{info, warn};

/// Detect hardware AES acceleration support
///
/// Returns true if:
/// - x86_64: AES-NI instructions available
/// - aarch64: ARM AES instructions available
/// - other: false (software fallback)
pub fn detect_aes_ni() -> bool {
    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("aes") {
            info!("✅ AES-NI hardware acceleration detected");
            return true;
        }
    }

    #[cfg(target_arch = "aarch64")]
    {
        if std::arch::is_aarch64_feature_detected!("aes") {
            info!("✅ ARM AES hardware acceleration detected");
            return true;
        }
    }

    warn!("⚠️ No hardware AES acceleration - using software AES fallback");
    false
}

/// Get CPU feature information for diagnostics
pub fn get_cpu_features() -> String {
    let mut features = Vec::new();

    #[cfg(target_arch = "x86_64")]
    {
        if is_x86_feature_detected!("aes") {
            features.push("aes");
        }
        if is_x86_feature_detected!("avx2") {
            features.push("avx2");
        }
        if is_x86_feature_detected!("sse4.2") {
            features.push("sse4.2");
        }
    }

    #[cfg(target_arch = "aarch64")]
    {
        if std::arch::is_aarch64_feature_detected!("aes") {
            features.push("aes");
        }
        if std::arch::is_aarch64_feature_detected!("sha2") {
            features.push("sha2");
        }
    }

    if features.is_empty() {
        "none".to_string()
    } else {
        features.join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_aes_ni() {
        // Should not panic
        let has_aes = detect_aes_ni();
        println!("Hardware AES support: {}", has_aes);
    }

    #[test]
    fn test_get_cpu_features() {
        let features = get_cpu_features();
        println!("CPU features: {}", features);
        assert!(!features.is_empty());
    }
}
