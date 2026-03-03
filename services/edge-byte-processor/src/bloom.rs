/// Simple bloom filter backed by a bit vector.
///
/// Uses k independent hash slices derived from a single SHA-256 digest,
/// following the Kirsch-Mitzenmacher technique (two base hashes generate k).

use ring::digest;

pub struct BloomFilter {
    bits: Vec<u64>,
    num_bits: u64,
    num_hashes: u32,
}

impl BloomFilter {
    pub fn new(capacity: u64, error_rate: f64) -> Self {
        let ln2 = core::f64::consts::LN_2;

        // m = -(n * ln(p)) / (ln2^2)
        let num_bits = (-(capacity as f64) * error_rate.ln() / (ln2 * ln2)).ceil() as u64;
        let num_bits = num_bits.max(64);

        // k = (m/n) * ln2
        let num_hashes = ((num_bits as f64 / capacity as f64) * ln2).ceil() as u32;
        let num_hashes = num_hashes.max(1);

        let words = ((num_bits + 63) / 64) as usize;
        BloomFilter {
            bits: vec![0u64; words],
            num_bits,
            num_hashes,
        }
    }

    fn hash_indices(&self, data: &[u8]) -> Vec<u64> {
        let dig = digest::digest(&digest::SHA256, data);
        let bytes = dig.as_ref();

        // Extract two 64-bit base hashes from the SHA-256 digest
        let h1 = u64::from_le_bytes(bytes[0..8].try_into().unwrap());
        let h2 = u64::from_le_bytes(bytes[8..16].try_into().unwrap());

        (0..self.num_hashes)
            .map(|i| {
                let combined = h1.wrapping_add((i as u64).wrapping_mul(h2));
                combined % self.num_bits
            })
            .collect()
    }

    pub fn add(&mut self, data: &[u8]) {
        for idx in self.hash_indices(data) {
            let word = (idx / 64) as usize;
            let bit = idx % 64;
            self.bits[word] |= 1u64 << bit;
        }
    }

    pub fn check(&self, data: &[u8]) -> bool {
        for idx in self.hash_indices(data) {
            let word = (idx / 64) as usize;
            let bit = idx % 64;
            if self.bits[word] & (1u64 << bit) == 0 {
                return false;
            }
        }
        true
    }
}
