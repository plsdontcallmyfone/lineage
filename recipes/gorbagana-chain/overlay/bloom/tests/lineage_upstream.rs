// Upstream's unit tests from bloom/src/bloom.rs (mod test), which patches may edit in place,
// kept under a protected path so the same assertions always run (recipe overlay, protected).
// The bodies are upstream's. Where upstream reads a private item, the same fact is read through
// the public API: num_bits_set through its accessor, a ConcurrentBloom's bit length and words
// through its conversion into a Bloom, and the private size formulas (num_bits, num_keys) through
// the filter Bloom::random builds from them.
use {
    rand::Rng,
    rayon::prelude::*,
    solana_bloom::bloom::{Bloom, ConcurrentBloom},
    solana_hash::Hash,
    solana_sha256_hasher::hash,
};

#[test]
fn test_bloom_filter() {
    //empty
    let bloom: Bloom<Hash> = Bloom::random(0, 0.1, 100);
    assert_eq!(bloom.keys.len(), 0);
    assert_eq!(bloom.bits.len(), 1);

    //normal
    let bloom: Bloom<Hash> = Bloom::random(10, 0.1, 100);
    assert_eq!(bloom.keys.len(), 3);
    assert_eq!(bloom.bits.len(), 48);

    //saturated
    let bloom: Bloom<Hash> = Bloom::random(100, 0.1, 100);
    assert_eq!(bloom.keys.len(), 1);
    assert_eq!(bloom.bits.len(), 100);
}

#[test]
fn test_add_contains() {
    let mut bloom: Bloom<Hash> = Bloom::random(100, 0.1, 100);
    //known keys to avoid false positives in the test
    bloom.keys = vec![0, 1, 2, 3];

    let key = hash(b"hello");
    assert!(!bloom.contains(&key));
    bloom.add(&key);
    assert!(bloom.contains(&key));

    let key = hash(b"world");
    assert!(!bloom.contains(&key));
    bloom.add(&key);
    assert!(bloom.contains(&key));
}

#[test]
fn test_random() {
    let mut b1: Bloom<Hash> = Bloom::random(10, 0.1, 100);
    let mut b2: Bloom<Hash> = Bloom::random(10, 0.1, 100);
    b1.keys.sort_unstable();
    b2.keys.sort_unstable();
    assert_ne!(b1.keys, b2.keys);
}

// upstream asserts num_bits(100, 0.1) == 480, num_bits(100, 0.01) == 959 and five num_keys
// values; Bloom::random(items, rate, max_bits) is those two formulas, so the same numbers are
// read off the filter it returns
#[test]
fn test_filter_math() {
    let bits = |items: usize, rate: f64| Bloom::<Hash>::random(items, rate, usize::MAX).bits.len();
    assert_eq!(bits(100, 0.1), 480u64);
    assert_eq!(bits(100, 0.01), 959u64);
    // num_keys(1000, 50) == 14: a rate that asks for more bits than the cap, so the cap is the bit length
    let keys = |num_bits: usize, items: usize| Bloom::<Hash>::random(items, 1e-30, num_bits).keys.len();
    assert_eq!(keys(1000, 50), 14);
    assert_eq!(keys(2000, 50), 28);
    assert_eq!(keys(2000, 25), 55);
    //ensure min keys is 1
    assert_eq!(keys(20, 1000), 1);
}

#[test]
fn test_debug() {
    let mut b: Bloom<Hash> = Bloom::new(3, vec![100]);
    b.add(&Hash::default());
    assert_eq!(
        format!("{b:?}"),
        "Bloom { keys.len: 1 bits.len: 3 num_set: 1 bits: 001 }"
    );

    let mut b: Bloom<Hash> = Bloom::new(1000, vec![100]);
    b.add(&Hash::default());
    b.add(&hash(&[1, 2]));
    assert_eq!(
        format!("{b:?}"),
        "Bloom { keys.len: 1 bits.len: 1000 num_set: 2 bits: 0000000000.. }"
    );
}

fn generate_random_hash() -> Hash {
    let mut rng = rand::rng();
    let mut hash = [0u8; solana_hash::HASH_BYTES];
    rng.fill(&mut hash);
    Hash::new_from_array(hash)
}

#[test]
fn test_atomic_bloom() {
    let hash_values: Vec<_> = std::iter::repeat_with(generate_random_hash)
        .take(1200)
        .collect();
    let bloom: ConcurrentBloom<_> = Bloom::<Hash>::random(1287, 0.1, 7424).into();
    hash_values.par_iter().for_each(|v| {
        bloom.add(v);
    });
    let bloom: Bloom<Hash> = bloom.into();
    assert_eq!(bloom.keys.len(), 3);
    assert_eq!(bloom.bits.len(), 6168);
    assert_eq!(bloom.bits.block_len(), 97);
    assert!(bloom.num_bits_set() > 2000);
    for hash_value in hash_values {
        assert!(bloom.contains(&hash_value));
    }
    let false_positive = std::iter::repeat_with(generate_random_hash)
        .take(10_000)
        .filter(|hash_value| bloom.contains(hash_value))
        .count();
    assert!(false_positive < 2_000, "false_positive: {false_positive}");
}

#[test]
fn test_atomic_bloom_round_trip() {
    let mut rng = rand::rng();
    let keys: Vec<_> = std::iter::repeat_with(|| rng.random()).take(5).collect();
    let mut bloom = Bloom::<Hash>::new(9731, keys.clone());
    let hash_values: Vec<_> = std::iter::repeat_with(generate_random_hash)
        .take(1000)
        .collect();
    for hash_value in &hash_values {
        bloom.add(hash_value);
    }
    let num_bits_set = bloom.num_bits_set();
    assert!(num_bits_set > 2000, "# bits set: {num_bits_set}");
    // Round-trip with no inserts.
    let bloom: ConcurrentBloom<_> = bloom.into();
    for hash_value in &hash_values {
        assert!(bloom.contains(hash_value));
    }
    let bloom: Bloom<_> = bloom.into();
    assert_eq!(bloom.bits.len(), 9731);
    assert_eq!(bloom.bits.block_len(), 9731_usize.div_ceil(64));
    assert_eq!(bloom.num_bits_set(), num_bits_set);
    for hash_value in &hash_values {
        assert!(bloom.contains(hash_value));
    }
    // Round trip, re-inserting the same hash values.
    let bloom: ConcurrentBloom<_> = bloom.into();
    hash_values.par_iter().for_each(|v| {
        bloom.add(v);
    });
    for hash_value in &hash_values {
        assert!(bloom.contains(hash_value));
    }
    let bloom: Bloom<_> = bloom.into();
    assert_eq!(bloom.num_bits_set(), num_bits_set);
    assert_eq!(bloom.bits.len(), 9731);
    for hash_value in &hash_values {
        assert!(bloom.contains(hash_value));
    }
    // Round trip, inserting new hash values.
    let more_hash_values: Vec<_> = std::iter::repeat_with(generate_random_hash)
        .take(1000)
        .collect();
    let bloom: ConcurrentBloom<_> = bloom.into();
    more_hash_values.par_iter().for_each(|v| {
        bloom.add(v);
    });
    for hash_value in &hash_values {
        assert!(bloom.contains(hash_value));
    }
    for hash_value in &more_hash_values {
        assert!(bloom.contains(hash_value));
    }
    let false_positive = std::iter::repeat_with(generate_random_hash)
        .take(10_000)
        .filter(|hash_value| bloom.contains(hash_value))
        .count();
    assert!(false_positive < 2000, "false_positive: {false_positive}");
    let bloom: Bloom<_> = bloom.into();
    assert_eq!(bloom.bits.len(), 9731);
    assert!(bloom.num_bits_set() > num_bits_set);
    assert!(
        bloom.num_bits_set() > 4000,
        "# bits set: {}",
        bloom.num_bits_set()
    );
    for hash_value in &hash_values {
        assert!(bloom.contains(hash_value));
    }
    for hash_value in &more_hash_values {
        assert!(bloom.contains(hash_value));
    }
    let false_positive = std::iter::repeat_with(generate_random_hash)
        .take(10_000)
        .filter(|hash_value| bloom.contains(hash_value))
        .count();
    assert!(false_positive < 2000, "false_positive: {false_positive}");
    // Assert that the bits vector precisely match if no atomic ops were
    // used.
    let bits = bloom.bits;
    let mut bloom = Bloom::<Hash>::new(9731, keys);
    for hash_value in &hash_values {
        bloom.add(hash_value);
    }
    for hash_value in &more_hash_values {
        bloom.add(hash_value);
    }
    assert_eq!(bits, bloom.bits);
}

#[test]
fn test_wincode_compatibility_bloom() {
    let mut rng = rand::rng();
    for _ in 0..1000 {
        let num_keys = rng.random_range(1..8usize);
        let keys: Vec<u64> = (0..num_keys).map(|_| rng.random()).collect();
        let num_bits = rng.random_range(1..1024usize);
        let mut bloom = Bloom::<Hash>::new(num_bits, keys);
        let num_inserts = rng.random_range(0..32usize);
        for _ in 0..num_inserts {
            bloom.add(&generate_random_hash());
        }

        let bincode_bytes = bincode::serialize(&bloom).unwrap();
        let wincode_bytes = wincode::serialize(&bloom).unwrap();
        assert_eq!(bincode_bytes, wincode_bytes);
        let wincode_decoded: Bloom<Hash> = wincode::deserialize(&bincode_bytes).unwrap();
        assert_eq!(bloom, wincode_decoded);
        let bincode_decoded: Bloom<Hash> = bincode::deserialize(&wincode_bytes).unwrap();
        assert_eq!(bloom, bincode_decoded);
    }
}
