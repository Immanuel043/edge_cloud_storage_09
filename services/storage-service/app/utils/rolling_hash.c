/*
 * Native C rolling hash for content-defined chunking.
 *
 * Implements the same Rabin-fingerprint algorithm as the Python version in
 * deduplication_enhanced.py but runs at native speed (~100x faster).
 *
 * Compiled during Docker build:
 *   gcc -O3 -shared -fPIC -o rolling_hash.so rolling_hash.c
 */

#include <stdint.h>
#include <stddef.h>

static uint64_t _power_mod32(uint64_t base, uint64_t exp) {
    uint64_t result = 1;
    base &= 0xFFFFFFFFULL;
    for (uint64_t i = 0; i < exp; i++) {
        result = (result * base) & 0xFFFFFFFFULL;
    }
    return result;
}

/*
 * Find content-defined chunk boundaries using a rolling hash.
 *
 * Parameters:
 *   data            - pointer to file data
 *   length          - number of bytes
 *   out_boundaries  - caller-allocated array to receive boundary positions
 *   max_boundaries  - capacity of out_boundaries
 *   min_block_size  - minimum bytes between boundaries
 *   max_block_size  - forced boundary if no natural one found
 *   window_size     - rolling hash window
 *   prime           - hash multiplier
 *   modulus_mask    - boundary trigger mask  (boundary when hash & mask == mask)
 *
 * Returns: number of boundaries written to out_boundaries.
 */
int64_t find_chunk_boundaries_c(
    const uint8_t *data,
    int64_t  length,
    int64_t *out_boundaries,
    int64_t  max_boundaries,
    int64_t  min_block_size,
    int64_t  max_block_size,
    int64_t  window_size,
    uint64_t prime,
    uint64_t modulus_mask)
{
    if (length < min_block_size) {
        if (max_boundaries > 0) {
            out_boundaries[0] = length;
            return 1;
        }
        return 0;
    }

    const uint64_t prime_to_window = _power_mod32(prime, (uint64_t)window_size);
    uint64_t hash_val = 0;
    int64_t  count = 0;
    int64_t  last_boundary = 0;

    for (int64_t i = 0; i < length; i++) {
        if (i >= window_size) {
            hash_val = (hash_val * prime
                        + (uint64_t)data[i]
                        - (uint64_t)data[i - window_size] * prime_to_window)
                       & 0xFFFFFFFFULL;
        } else {
            hash_val = (hash_val * prime + (uint64_t)data[i])
                       & 0xFFFFFFFFULL;
        }

        if (i >= min_block_size) {
            int emit = 0;
            if ((hash_val & modulus_mask) == modulus_mask) {
                emit = 1;
            } else if ((i - last_boundary) >= max_block_size) {
                emit = 1;
            }
            if (emit) {
                if (count >= max_boundaries)
                    break;
                out_boundaries[count] = i + 1;
                last_boundary = i + 1;
                count++;
            }
        }
    }

    /* Final boundary (matches Python: append len if missing) */
    if (count == 0 || out_boundaries[count - 1] != length) {
        if (count < max_boundaries) {
            out_boundaries[count] = length;
            count++;
        }
    }

    return count;
}
