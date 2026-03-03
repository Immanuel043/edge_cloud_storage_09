// Server module - Unix Domain Socket HTTP server
pub mod request;
pub mod response;
pub mod handlers;
pub mod dedup_handler;
pub mod fd_guard;
pub mod uds_server;
pub mod uds_server_scm;
pub mod scm_rights;

pub use request::{ChunkRequest, UploadRequest, DownloadRequest};
pub use response::{ChunkResponse, ErrorResponse};
pub use handlers::{UploadHandler, DownloadHandler};
pub use uds_server::{UnixSocketServer, ServerConfig};
pub use uds_server_scm::UnixSocketServerWithScmRights;
