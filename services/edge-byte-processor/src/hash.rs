/// Batch SHA-256 hashing using ring.
///
/// Given a contiguous data buffer and an array of chunk boundary offsets,
/// computes SHA-256 for each chunk and writes raw 32-byte digests to a
/// caller-allocated output buffer.

use ring::digest;

/// Compute SHA-256 for each chunk defined by `offsets`.
///
/// `offsets` contains `count` boundary positions (ascending). Chunk i spans
/// `[offsets[i-1] .. offsets[i])` with the first chunk starting at byte 0.
///
/// Each 32-byte digest is written sequentially to `out_hashes`.
///
/// Returns 0 on success, -1 on invalid input.
///
/// # Safety
///
/// - `data` must point to at least `offsets[count-1]` bytes.
/// - `offsets` must have `count` valid i64 entries.
/// - `out_hashes` must have room for `count * 32` bytes.
pub unsafe fn batch_sha256(
    data: *const u8,
    offsets: *const i64,
    count: i64,
    out_hashes: *mut u8,
) -> i32 {
    if count <= 0 || data.is_null() || offsets.is_null() || out_hashes.is_null() {
        return -1;
    }

    let mut start: usize = 0;

    for i in 0..count as usize {
        let end = *offsets.add(i) as usize;
        if end < start {
            return -1;
        }

        let chunk = core::slice::from_raw_parts(data.add(start), end - start);
        let digest = digest::digest(&digest::SHA256, chunk);
        let hash_bytes = digest.as_ref();

        core::ptr::copy_nonoverlapping(
            hash_bytes.as_ptr(),
            out_hashes.add(i * 32),
            32,
        );

        start = end;
    }

    0
}
