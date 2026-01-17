# SCM_RIGHTS Implementation Status

## Current State

The Rust data plane has **all the processing logic** for Non-ZK mode:
- ✅ AES-256-GCM encryption with hardware AES-NI
- ✅ Zstandard compression
- ✅ memfd key reading (Linux & macOS)
- ✅ Mode enforcement
- ✅ Full test coverage (170+ tests)

**Missing**: Extraction of file descriptor from SCM_RIGHTS ancillary data in the HTTP server.

## The Challenge

### Current Placeholder Implementation

**File**: `src/server/uds_server.rs` (lines 195-200, 293-297)

```rust
// Extract key FD from header (in production, this would come from SCM_RIGHTS)
// For now, we read the FD number from header as a placeholder
let key_fd = headers
    .get("x-file-key-fd")
    .and_then(|v| v.to_str().ok())
    .and_then(|s| s.parse::<i32>().ok());
```

**Problem**: This reads the FD number from an HTTP header string, which is insecure and doesn't work with the Python client's SCM_RIGHTS implementation.

### Why It's Complex

The server uses **Hyper** (high-level HTTP library) which abstracts away the socket layer. SCM_RIGHTS ancillary data is at the Unix socket level, **below** HTTP.

**Architecture**:
```
Python Client                              Rust Server
─────────────                              ────────────
sendmsg() with SCM_RIGHTS                  UnixListener::accept()
  │                                          │
  │ Unix Socket Layer (kernel)               │
  │ [FD passed via ancillary data]           │
  │                                          ▼
  └────────────────────────────────▶    TokioIo::new(stream)
                                           │
                                           ▼
                                        Hyper HTTP/1
                                           │
                                           ▼
                                        handle_request()
                                           │
                                           ▼
                                        [FD should be here but isn't]
```

Hyper's `http1::Builder` wraps the UnixStream and we lose access to the raw socket for `recvmsg()`.

## Solution Approaches

### Approach 1: Custom HTTP Parser (Recommended Long-Term)

Replace Hyper's HTTP parsing with a custom implementation that:
1. Uses `recvmsg()` to read HTTP request + ancillary data
2. Parses HTTP headers manually
3. Extracts FD from ancillary data
4. Passes FD to handlers

**Pros**:
- Full control over socket operations
- Proper security (FD never in HTTP layer)
- Production-ready

**Cons**:
- ~500 lines of custom HTTP parsing code
- Need to handle HTTP edge cases
- More testing required

**Implementation Time**: 4-6 hours

### Approach 2: Pre-read Ancillary Data (Hybrid)

Intercept the UnixStream before passing to Hyper:
1. Before Hyper HTTP parsing, peek at socket with `recv_vectored_with_ancillary`
2. Extract FD if present
3. Store FD in request context
4. Let Hyper handle HTTP as normal

**Pros**:
- Keeps Hyper for HTTP parsing
- Less code to write

**Cons**:
- Complex socket lifecycle management
- Risk of breaking Hyper's assumptions
- Still ~300 lines of code

**Implementation Time**: 3-4 hours

### Approach 3: Separate Control Channel (Alternative)

Use two Unix sockets:
1. Control socket (for FD passing only)
2. Data socket (for HTTP/chunks via Hyper)

**Flow**:
```
Client:
  1. Send FD via control socket
  2. Send HTTP request via data socket with reference ID
  3. Server correlates FD with request

Server:
  1. Receive FD from control socket, store with ID
  2. Receive HTTP request from data socket
  3. Look up FD by ID
```

**Pros**:
- Clean separation of concerns
- Hyper untouched

**Cons**:
- Two socket connections per request
- More complex client code
- Performance overhead

**Implementation Time**: 2-3 hours

## Current Workaround

For immediate testing and development, the system works with a **functional limitation**:

1. Python client sends FD number as a header (`x-file-key-fd: 3`)
2. Rust server reads the header
3. Rust attempts to read from that FD number

**This works IF**:
- The FD number happens to be valid in Rust's process
- The FD points to a readable file with a key
- This is INSECURE for production (FD leaked in logs)

**For testing purposes**, you can manually pass a test FD, but this is NOT production-ready.

## Recommended Path Forward

### Phase 1: Immediate (Current)
- ✅ Python client sends FD via SCM_RIGHTS (done)
- ⚠️ Rust server reads FD from header (placeholder)
- ✅ All processing logic works (done)
- Use for development/testing only

### Phase 2: Production Implementation (Next)
- Implement **Approach 1** (custom HTTP parser)
- Full SCM_RIGHTS extraction
- Security audit
- ~4-6 hours implementation
- ~2-4 hours testing

### Phase 3: Optimization (Future)
- Benchmark performance
- Consider `io_uring` for both socket I/O and file operations
- Profile and optimize hot paths

## Code Locations for Phase 2

When implementing full SCM_RIGHTS:

**Files to Modify**:
1. `src/server/uds_server.rs` (lines 70-120)
   - Replace `http1::Builder` with custom HTTP handler
   - Add `recvmsg()` call before HTTP parsing
   - Extract FD from ancillary data

2. `src/server/http_parser.rs` (NEW)
   - Custom HTTP/1.1 request parser
   - Handles chunked encoding
   - Returns parsed request + FD

3. `Cargo.toml`
   - Add `nix` crate (for `recvmsg()` types)

**Skeleton Code**:
```rust
// src/server/uds_server.rs
use nix::sys::socket::{recvmsg, ControlMessageOwned, MsgFlags};
use nix::sys::uio::IoVec;

async fn handle_connection(mut stream: UnixStream) -> Result<(), Error> {
    // 1. Read with ancillary data
    let mut buf = vec![0u8; 8192];
    let mut ancillary_buf = vec![0u8; 64];

    let iov = [IoVec::from_mut_slice(&mut buf)];
    let msg = recvmsg(
        stream.as_raw_fd(),
        &iov,
        Some(&mut ancillary_buf),
        MsgFlags::empty()
    )?;

    // 2. Extract FD from ancillary data
    let mut fd_opt = None;
    for cmsg in msg.cmsgs() {
        if let ControlMessageOwned::ScmRights(fds) = cmsg {
            fd_opt = fds.first().copied();
            break;
        }
    }

    // 3. Parse HTTP from buffer
    let request = parse_http_request(&buf[..msg.bytes])?;

    // 4. Process with FD
    let response = handle_request(request, fd_opt).await?;

    // 5. Send HTTP response
    stream.write_all(response.as_bytes()).await?;

    Ok(())
}
```

## Testing Without Full SCM_RIGHTS

Until Phase 2 is implemented, you can test Non-ZK mode by:

1. **Manual FD passing**: Create a test that opens a file with a key, passes its FD number as a header
2. **Mock testing**: Unit tests that directly call handlers with FDs
3. **ZK mode**: Use ZK mode for end-to-end testing (no FD needed)

## References

- Python `sendmsg()`: https://docs.python.org/3/library/socket.html#socket.socket.sendmsg
- Rust `recvmsg()`: https://docs.rs/nix/latest/nix/sys/socket/fn.recvmsg.html
- SCM_RIGHTS: https://man7.org/linux/man-pages/man3/cmsg.3.html
- Hyper server: https://docs.rs/hyper/latest/hyper/server/

## Status

**Current Implementation**: ⚠️ Phase 1 (Development/Testing)
**Production Ready**: ❌ Requires Phase 2 (SCM_RIGHTS extraction)
**Estimated to Production**: 6-10 hours (implementation + testing + security audit)
