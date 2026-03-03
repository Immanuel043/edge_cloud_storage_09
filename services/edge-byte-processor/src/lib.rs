//! edge-byte-processor -- C FFI exports for Python ctypes.
//!
//! Provides three capabilities:
//!   1. Content-Defined Chunking (FastCDC gear hash)
//!   2. Batch SHA-256 hashing
//!   3. Bloom filter (opaque pointer API)

mod bloom;
mod cdc;
mod hash;

use bloom::BloomFilter;

// ---------------------------------------------------------------------------
// CDC -- FastCDC (primary) and legacy-compat wrapper
// ---------------------------------------------------------------------------

/// FastCDC chunking with normalized two-phase gear hash.
/// This is the recommended entry point.
#[no_mangle]
pub unsafe extern "C" fn ebp_fastcdc(
    data: *const u8,
    length: i64,
    out_boundaries: *mut i64,
    max_boundaries: i64,
    min_block_size: i64,
    max_block_size: i64,
    avg_block_size: i64,
) -> i64 {
    cdc::find_chunk_boundaries_fastcdc(
        data,
        length,
        out_boundaries,
        max_boundaries,
        min_block_size,
        max_block_size,
        avg_block_size,
    )
}

/// Legacy-compatible wrapper that accepts old Rabin parameters but
/// internally runs FastCDC (ignores window_size, prime, modulus_mask).
#[no_mangle]
pub unsafe extern "C" fn ebp_find_chunk_boundaries(
    data: *const u8,
    length: i64,
    out_boundaries: *mut i64,
    max_boundaries: i64,
    min_block_size: i64,
    max_block_size: i64,
    window_size: i64,
    prime: u64,
    modulus_mask: u64,
) -> i64 {
    cdc::find_chunk_boundaries_compat(
        data,
        length,
        out_boundaries,
        max_boundaries,
        min_block_size,
        max_block_size,
        window_size,
        prime,
        modulus_mask,
    )
}

// ---------------------------------------------------------------------------
// Batch SHA-256
// ---------------------------------------------------------------------------

#[no_mangle]
pub unsafe extern "C" fn ebp_batch_sha256(
    data: *const u8,
    offsets: *const i64,
    count: i64,
    out_hashes: *mut u8,
) -> i32 {
    hash::batch_sha256(data, offsets, count, out_hashes)
}

// ---------------------------------------------------------------------------
// Bloom filter (opaque pointer)
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn ebp_bloom_create(capacity: u64, error_rate: f64) -> *mut BloomFilter {
    let filter = Box::new(BloomFilter::new(capacity, error_rate));
    Box::into_raw(filter)
}

#[no_mangle]
pub unsafe extern "C" fn ebp_bloom_add(
    filter: *mut BloomFilter,
    data: *const u8,
    len: u64,
) {
    if filter.is_null() || data.is_null() {
        return;
    }
    let slice = core::slice::from_raw_parts(data, len as usize);
    (*filter).add(slice);
}

#[no_mangle]
pub unsafe extern "C" fn ebp_bloom_check(
    filter: *const BloomFilter,
    data: *const u8,
    len: u64,
) -> i32 {
    if filter.is_null() || data.is_null() {
        return 0;
    }
    let slice = core::slice::from_raw_parts(data, len as usize);
    if (*filter).check(slice) { 1 } else { 0 }
}

#[no_mangle]
pub unsafe extern "C" fn ebp_bloom_destroy(filter: *mut BloomFilter) {
    if !filter.is_null() {
        drop(Box::from_raw(filter));
    }
}
