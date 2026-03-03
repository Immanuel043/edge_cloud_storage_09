/// FastCDC -- Content-Defined Chunking using a gear hash.
///
/// Based on the FastCDC algorithm (Wen Xia et al., 2016):
///   "FastCDC: a Fast and Efficient Content-Defined Chunking Approach
///    for Data Deduplication"
///
/// Performance advantage over Rabin fingerprint:
///   - Single table lookup + XOR per byte (vs multiply + subtract for Rabin)
///   - No sliding window state to maintain
///   - Normalized chunking via two-phase mask for better distribution
///
/// The gear table is a pre-computed array of 256 random 64-bit values.
/// For each byte: hash = (hash << 1) + GEAR_TABLE[byte]
/// Boundary when: (hash & mask) == 0

/// 256-entry gear hash table (deterministic pseudo-random values).
/// Generated from a known seed so all nodes produce identical boundaries.
static GEAR: [u64; 256] = {
    // Computed via a simple LCG seeded with a fixed value.
    // The exact values don't matter as long as they're well-distributed
    // and the same across all builds.
    let mut table = [0u64; 256];
    let mut state: u64 = 0x1571_AFE5_9B3D_2C01;
    let mut i = 0;
    while i < 256 {
        // xorshift64
        state ^= state << 13;
        state ^= state >> 7;
        state ^= state << 17;
        table[i] = state;
        i += 1;
    }
    table
};

/// Compute the mask for a target average chunk size.
/// FastCDC uses `bits = log2(avg_size)` and mask = (1 << bits) - 1.
const fn mask_for_avg(avg_size: u64) -> u64 {
    let bits = 63 - avg_size.leading_zeros() as u64;
    (1u64 << bits) - 1
}

/// FastCDC with normalized chunking (two masks).
///
/// Uses a stricter mask in the first half of the target window (harder to
/// cut -- biases toward larger chunks), and a looser mask in the second half
/// (easier to cut -- prevents chunks from growing too large). This produces
/// a tighter chunk-size distribution centered around `avg_size`.
///
/// # Safety
///
/// `data` must point to `length` valid bytes.
/// `out_boundaries` must have room for at least `max_boundaries` entries.
pub unsafe fn find_chunk_boundaries_fastcdc(
    data: *const u8,
    length: i64,
    out_boundaries: *mut i64,
    max_boundaries: i64,
    min_block_size: i64,
    max_block_size: i64,
    avg_block_size: i64,
) -> i64 {
    if length <= 0 || max_boundaries <= 0 {
        return 0;
    }

    if length <= min_block_size {
        *out_boundaries = length;
        return 1;
    }

    let avg = avg_block_size as u64;
    // Normalized chunking: stricter mask for first half, looser for second
    let mask_large = mask_for_avg(avg) << 1 | 1; // +1 bit  -> harder to match
    let mask_small = mask_for_avg(avg) >> 1;       // -1 bit  -> easier to match
    let normal_size = avg_block_size;

    let data_slice = core::slice::from_raw_parts(data, length as usize);
    let mut count: i64 = 0;
    let mut offset: i64 = 0;

    while offset < length {
        let remaining = length - offset;
        if remaining <= min_block_size {
            // Whatever is left becomes the final chunk
            break;
        }

        let chunk_end = (offset + max_block_size).min(length);
        let skip_to = offset + min_block_size;
        let normal_boundary = offset + normal_size;

        let mut hash: u64 = 0;
        let mut i = skip_to;

        // Phase 1: harder mask (up to avg chunk size)
        let phase1_end = normal_boundary.min(chunk_end);
        while i < phase1_end {
            hash = (hash << 1).wrapping_add(GEAR[data_slice[i as usize] as usize]);
            if hash & mask_large == 0 {
                break;
            }
            i += 1;
        }

        if i < phase1_end {
            // Found boundary in phase 1
            let boundary = i + 1;
            if count >= max_boundaries {
                break;
            }
            *out_boundaries.offset(count as isize) = boundary;
            count += 1;
            offset = boundary;
            continue;
        }

        // Phase 2: easier mask (from avg to max)
        while i < chunk_end {
            hash = (hash << 1).wrapping_add(GEAR[data_slice[i as usize] as usize]);
            if hash & mask_small == 0 {
                break;
            }
            i += 1;
        }

        let boundary = if i < chunk_end {
            i + 1
        } else {
            chunk_end // forced cut at max_block_size
        };

        if count >= max_boundaries {
            break;
        }
        *out_boundaries.offset(count as isize) = boundary;
        count += 1;
        offset = boundary;
    }

    // Final boundary: include any trailing bytes
    if count == 0 || *out_boundaries.offset((count - 1) as isize) != length {
        if count < max_boundaries {
            *out_boundaries.offset(count as isize) = length;
            count += 1;
        }
    }

    count
}

/// Legacy Rabin-compatible wrapper (same FFI signature as the old C code).
/// Delegates to FastCDC, ignoring window_size / prime / modulus_mask.
///
/// # Safety
///
/// Same requirements as `find_chunk_boundaries_fastcdc`.
pub unsafe fn find_chunk_boundaries_compat(
    data: *const u8,
    length: i64,
    out_boundaries: *mut i64,
    max_boundaries: i64,
    min_block_size: i64,
    max_block_size: i64,
    _window_size: i64,
    _prime: u64,
    _modulus_mask: u64,
) -> i64 {
    // Derive avg_block_size from min and max (geometric mean approximation)
    let avg_block_size = (min_block_size + max_block_size) / 2;
    find_chunk_boundaries_fastcdc(
        data,
        length,
        out_boundaries,
        max_boundaries,
        min_block_size,
        max_block_size,
        avg_block_size,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_small_data() {
        let data = vec![0u8; 100];
        let mut out = vec![0i64; 10];
        let count = unsafe {
            find_chunk_boundaries_fastcdc(
                data.as_ptr(), 100, out.as_mut_ptr(), 10,
                200, 800, 400, // min > data length
            )
        };
        assert_eq!(count, 1);
        assert_eq!(out[0], 100); // entire data as one chunk
    }

    #[test]
    fn test_boundaries_within_range() {
        let min = 1024i64;
        let max = 8192i64;
        let avg = 4096i64;

        // 1MB of pseudo-random data
        let mut data = vec![0u8; 1024 * 1024];
        let mut rng: u64 = 42;
        for b in data.iter_mut() {
            rng ^= rng << 13;
            rng ^= rng >> 7;
            rng ^= rng << 17;
            *b = rng as u8;
        }

        let max_boundaries = (data.len() / min as usize + 2) as i64;
        let mut out = vec![0i64; max_boundaries as usize];
        let count = unsafe {
            find_chunk_boundaries_fastcdc(
                data.as_ptr(), data.len() as i64,
                out.as_mut_ptr(), max_boundaries,
                min, max, avg,
            )
        };

        assert!(count > 0);
        assert_eq!(out[(count - 1) as usize], data.len() as i64);

        // Verify all chunk sizes are within [min, max] (except possibly the last)
        let mut prev = 0i64;
        for i in 0..count as usize {
            let size = out[i] - prev;
            if i < (count - 1) as usize {
                assert!(size >= min, "chunk {} size {} < min {}", i, size, min);
                assert!(size <= max, "chunk {} size {} > max {}", i, size, max);
            }
            prev = out[i];
        }
    }

    #[test]
    fn test_deterministic() {
        let data = vec![0xABu8; 50_000];
        let mut out1 = vec![0i64; 100];
        let mut out2 = vec![0i64; 100];

        let c1 = unsafe {
            find_chunk_boundaries_fastcdc(
                data.as_ptr(), data.len() as i64,
                out1.as_mut_ptr(), 100, 1024, 8192, 4096,
            )
        };
        let c2 = unsafe {
            find_chunk_boundaries_fastcdc(
                data.as_ptr(), data.len() as i64,
                out2.as_mut_ptr(), 100, 1024, 8192, 4096,
            )
        };

        assert_eq!(c1, c2);
        assert_eq!(&out1[..c1 as usize], &out2[..c2 as usize]);
    }

    #[test]
    fn test_compat_wrapper() {
        let data = vec![0x42u8; 100_000];
        let mut out = vec![0i64; 200];
        let count = unsafe {
            find_chunk_boundaries_compat(
                data.as_ptr(), data.len() as i64,
                out.as_mut_ptr(), 200,
                1024, 8192, 48, 3, 8191, // legacy Rabin params (ignored)
            )
        };
        assert!(count > 0);
        assert_eq!(out[(count - 1) as usize], data.len() as i64);
    }
}
