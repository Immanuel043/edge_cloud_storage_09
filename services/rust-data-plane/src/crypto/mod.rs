pub mod aes_gcm;
pub mod hardware;
pub mod key_manager;

#[cfg(target_os = "linux")]
pub mod memfd;

#[cfg(target_os = "macos")]
pub mod memfd_macos;

pub use aes_gcm::AesGcmCipher;
pub use hardware::detect_aes_ni;
pub use key_manager::SecretKey;

#[cfg(target_os = "linux")]
pub use memfd::read_key_from_memfd;

#[cfg(target_os = "macos")]
pub use memfd_macos::read_key_from_memfd;
