//! SCM_RIGHTS - Secure file descriptor passing over Unix Domain Socket
//!
//! This module handles receiving file descriptors via SCM_RIGHTS ancillary data
//! for secure encryption key passing in Non-ZK mode.

use nix::sys::socket::{recvmsg, ControlMessageOwned, MsgFlags};
use std::io::IoSliceMut;
use std::os::unix::io::RawFd;
use tracing::{debug, trace};

/// Extract file descriptor from SCM_RIGHTS ancillary data
///
/// This function receives data from a Unix socket and extracts any file descriptor
/// sent via SCM_RIGHTS control message. This is used for secure key passing.
///
/// # Arguments
/// * `fd` - The socket file descriptor to receive from
/// * `buffer` - Buffer to store regular data
/// * `ancillary_buffer` - Buffer to store ancillary (control) data
///
/// # Returns
/// * `Ok((bytes_read, optional_fd))` - Number of bytes read and optional FD if present
/// * `Err(error)` - If receive fails
///
/// # Security
/// - FD is passed at kernel level, never in HTTP
/// - Automatic cleanup if FD is not used
/// - No logging of FD numbers or key data
pub fn recv_with_scm_rights(
    fd: RawFd,
    buffer: &mut [u8],
    ancillary_buffer: &mut Vec<u8>,
) -> Result<(usize, Option<RawFd>), nix::Error> {
    // Prepare IoSliceMut for data buffer
    let mut iov = [IoSliceMut::new(buffer)];

    // Receive message with ancillary data
    trace!("Receiving message with potential SCM_RIGHTS data");
    let msg = recvmsg::<()>(fd, &mut iov, Some(ancillary_buffer), MsgFlags::empty())?;

    let bytes_read = msg.bytes;
    debug!(bytes_read, "Received data from socket");

    // Extract file descriptor from ancillary data
    let mut received_fd: Option<RawFd> = None;

    if let Ok(cmsg_iter) = msg.cmsgs() {
        for cmsg in cmsg_iter {
            if let ControlMessageOwned::ScmRights(fds) = cmsg {
                if let Some(&first_fd) = fds.first() {
                    received_fd = Some(first_fd);
                    debug!(fd = first_fd, "Extracted FD from SCM_RIGHTS");

                    // Warn if multiple FDs sent (we only use first)
                    if fds.len() > 1 {
                        trace!(
                            count = fds.len(),
                            "Multiple FDs received via SCM_RIGHTS, using first only"
                        );
                    }
                }
            } else {
                // Ignore other control messages
                trace!("Ignoring non-SCM_RIGHTS control message");
            }
        }
    }

    Ok((bytes_read, received_fd))
}

/// Parse HTTP request headers from buffer
///
/// Extracts HTTP method, path, and headers from raw HTTP/1.1 request.
///
/// # Arguments
/// * `buffer` - Raw HTTP request data
/// * `bytes_read` - Number of valid bytes in buffer
///
/// # Returns
/// * `Ok((method, path, headers, body_start))` - Parsed request components
/// * `Err(message)` - If parsing fails
pub fn parse_http_request(
    buffer: &[u8],
    bytes_read: usize,
) -> Result<(String, String, Vec<(String, String)>, usize), String> {
    let data = &buffer[..bytes_read];

    // Find end of headers (\r\n\r\n)
    let headers_end = data
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or("Incomplete HTTP request (no header terminator)")?;

    // Parse headers section
    let headers_section = std::str::from_utf8(&data[..headers_end])
        .map_err(|e| format!("Invalid UTF-8 in headers: {}", e))?;

    let mut lines = headers_section.lines();

    // Parse request line (e.g., "POST /upload HTTP/1.1")
    let request_line = lines.next().ok_or("Empty HTTP request")?;
    let parts: Vec<&str> = request_line.split_whitespace().collect();

    if parts.len() < 3 {
        return Err(format!("Invalid HTTP request line: {}", request_line));
    }

    let method = parts[0].to_string();
    let path = parts[1].to_string();

    // Parse headers
    let mut headers = Vec::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            headers.push((
                key.trim().to_lowercase(),
                value.trim().to_string(),
            ));
        }
    }

    // Body starts after \r\n\r\n
    let body_start = headers_end + 4;

    trace!(
        method = %method,
        path = %path,
        header_count = headers.len(),
        "Parsed HTTP request"
    );

    Ok((method, path, headers, body_start))
}

/// Read remaining body data from socket
///
/// After parsing headers, this reads the remaining body data based on Content-Length.
///
/// # Arguments
/// * `fd` - Socket file descriptor
/// * `initial_buffer` - Buffer containing initial data (may include partial body)
/// * `body_start` - Offset where body starts in initial_buffer
/// * `content_length` - Expected body length from Content-Length header
///
/// # Returns
/// * `Ok(body_bytes)` - Complete body data
/// * `Err(error)` - If read fails
pub fn read_body(
    fd: RawFd,
    initial_buffer: &[u8],
    body_start: usize,
    content_length: usize,
) -> Result<Vec<u8>, String> {
    let mut body = Vec::with_capacity(content_length);

    // Copy any body data from initial buffer
    let initial_body_len = initial_buffer.len().saturating_sub(body_start);
    if initial_body_len > 0 {
        let copy_len = initial_body_len.min(content_length);
        body.extend_from_slice(&initial_buffer[body_start..body_start + copy_len]);
        trace!(copied = copy_len, "Copied partial body from initial buffer");
    }

    // Read remaining body if needed
    if body.len() < content_length {
        let remaining = content_length - body.len();
        let mut temp_buffer = vec![0u8; remaining.min(64 * 1024)]; // 64KB chunks

        while body.len() < content_length {
            let to_read = (content_length - body.len()).min(temp_buffer.len());
            let mut iov = [IoSliceMut::new(&mut temp_buffer[..to_read])];

            let msg = recvmsg::<()>(fd, &mut iov, None, MsgFlags::empty())
                .map_err(|e| format!("Failed to read body: {}", e))?;

            if msg.bytes == 0 {
                return Err(format!(
                    "Socket closed before body complete: got {}/{} bytes",
                    body.len(),
                    content_length
                ));
            }

            // Copy the bytes we read before modifying iov again
            let bytes_to_copy = msg.bytes;
            body.extend_from_slice(&temp_buffer[..bytes_to_copy]);
            trace!(read = bytes_to_copy, total = body.len(), "Read body chunk");
        }
    }

    debug!(size = body.len(), "Completed body read");
    Ok(body)
}

/// Build HTTP response
///
/// Constructs a complete HTTP/1.1 response with headers and body.
///
/// # Arguments
/// * `status_code` - HTTP status code (e.g., 200, 400, 500)
/// * `status_text` - Status message (e.g., "OK", "Bad Request")
/// * `body` - Response body (JSON)
/// * `additional_headers` - Optional extra headers
///
/// # Returns
/// * Complete HTTP response as bytes
pub fn build_http_response(
    status_code: u16,
    status_text: &str,
    body: &str,
    additional_headers: &[(String, String)],
) -> Vec<u8> {
    let mut response = format!("HTTP/1.1 {} {}\r\n", status_code, status_text);
    response.push_str(&format!("Content-Type: application/json\r\n"));
    response.push_str(&format!("Content-Length: {}\r\n", body.len()));
    response.push_str("Connection: close\r\n");

    // Add additional headers
    for (key, value) in additional_headers {
        response.push_str(&format!("{}: {}\r\n", key, value));
    }

    response.push_str("\r\n");
    response.push_str(body);

    trace!(
        status = status_code,
        body_len = body.len(),
        "Built HTTP response"
    );

    response.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_http_request() {
        let request = b"POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Length: 10\r\n\r\nHello";

        let (method, path, headers, body_start) = parse_http_request(request, request.len())
            .expect("Failed to parse");

        assert_eq!(method, "POST");
        assert_eq!(path, "/upload");
        assert_eq!(headers.len(), 2);
        assert_eq!(headers[0].0, "host");
        assert_eq!(headers[0].1, "localhost");
        assert_eq!(headers[1].0, "content-length");
        assert_eq!(headers[1].1, "10");
        assert_eq!(body_start, 53); // Position after \r\n\r\n
    }

    #[test]
    fn test_parse_http_request_minimal() {
        let request = b"GET /health HTTP/1.1\r\n\r\n";

        let (method, path, headers, _) = parse_http_request(request, request.len())
            .expect("Failed to parse");

        assert_eq!(method, "GET");
        assert_eq!(path, "/health");
        assert_eq!(headers.len(), 0);
    }

    #[test]
    fn test_build_http_response() {
        let response = build_http_response(
            200,
            "OK",
            r#"{"success":true}"#,
            &[],
        );

        let response_str = String::from_utf8(response).unwrap();

        assert!(response_str.starts_with("HTTP/1.1 200 OK\r\n"));
        assert!(response_str.contains("Content-Type: application/json\r\n"));
        assert!(response_str.contains("Content-Length: 16\r\n"));
        assert!(response_str.ends_with(r#"{"success":true}"#));
    }

    #[test]
    fn test_parse_invalid_request() {
        let request = b"INVALID";
        let result = parse_http_request(request, request.len());
        assert!(result.is_err());
    }

    #[test]
    fn test_parse_incomplete_request() {
        let request = b"POST /upload HTTP/1.1\r\nHost: localhost";
        let result = parse_http_request(request, request.len());
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("no header terminator"));
    }
}
