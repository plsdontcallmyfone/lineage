// Lineage property tests for solana-bloom in gorbagana-chain (recipe overlay, protected).
// Every filter is checked bit for bit against a model written here from the definition, with no
// code shared with the crate: bit position = FNV-1a of the item's bytes, started from the key
// instead of the offset basis, modulo the bit length; an item is present when all of its
// positions are set. Inputs are a fixed splitmix64 stream, so the tests do not depend on OS
// randomness and no data is embedded. Shapes are the ones the validator uses (32-byte hashes,
// 64-byte signatures, bit lengths that are not powers of two) plus short and long byte strings.
use solana_bloom::bloom::{Bloom, BloomHashIndex, ConcurrentBloom, ConcurrentBloomInterval};

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e3779b97f4a7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58476d1ce4e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d049bb133111eb);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
    fn bytes(&mut self, n: usize) -> Vec<u8> {
        (0..n).map(|_| self.next() as u8).collect()
    }
}

fn model_hash(key: u64, bytes: &[u8]) -> u64 {
    let mut h = key;
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

struct Model {
    keys: Vec<u64>,
    bits: Vec<bool>,
}

impl Model {
    fn new(num_bits: usize, keys: &[u64]) -> Model {
        Model { keys: keys.to_vec(), bits: vec![false; num_bits] }
    }
    fn positions(&self, item: &[u8]) -> Vec<usize> {
        self.keys.iter().map(|k| (model_hash(*k, item) % self.bits.len() as u64) as usize).collect()
    }
    /// true when the item set at least one new bit
    fn add(&mut self, item: &[u8]) -> bool {
        let mut fresh = false;
        for p in self.positions(item) {
            fresh |= !self.bits[p];
            self.bits[p] = true;
        }
        fresh
    }
    fn contains(&self, item: &[u8]) -> bool {
        self.positions(item).iter().all(|p| self.bits[*p])
    }
    fn ones(&self) -> u64 {
        self.bits.iter().filter(|b| **b).count() as u64
    }
}

fn assert_same<T: BloomHashIndex>(b: &Bloom<T>, m: &Model, what: &str) {
    assert_eq!(b.bits.len(), m.bits.len() as u64, "{what}: bit length");
    assert_eq!(b.num_bits_set(), m.ones(), "{what}: set-bit count");
    for (i, want) in m.bits.iter().enumerate() {
        assert_eq!(b.bits.get(i as u64), *want, "{what}: bit {i}");
    }
}

// (bit length, number of keys, item length; 0 means 1 to 150 bytes, drawn per item)
const SHAPES: &[(usize, usize, usize)] = &[
    (48, 3, 32),
    (100, 1, 32),
    (6168, 3, 32),
    (7424, 3, 32),
    (9731, 5, 32),
    (59_393, 4, 32),
    (38_341, 27, 64),
    (1000, 8, 64),
    (65, 2, 0),
    (4097, 6, 0),
    (20_011, 7, 0),
];

fn items(r: &mut Rng, n: usize, len: usize) -> Vec<Vec<u8>> {
    (0..n)
        .map(|_| {
            let l = if len == 0 { 1 + r.below(150) as usize } else { len };
            r.bytes(l)
        })
        .collect()
}

#[test]
fn hash_at_index_is_keyed_fnv1a() {
    let mut r = Rng(1);
    for len in 0..200usize {
        let v = r.bytes(len);
        for key in [0u64, 1, 0xcbf29ce484222325, u64::MAX, r.next()] {
            assert_eq!(v.hash_at_index(key), model_hash(key, &v), "len {len} key {key}");
        }
    }
    let mut a = [0u8; 32];
    a.copy_from_slice(&r.bytes(32));
    let mut s = [0u8; 64];
    s.copy_from_slice(&r.bytes(64));
    for key in [0u64, 7, u64::MAX] {
        assert_eq!(a.hash_at_index(key), model_hash(key, &a));
        assert_eq!(s.hash_at_index(key), model_hash(key, &s));
    }
}

#[test]
fn bloom_matches_model() {
    let mut r = Rng(2);
    for (si, &(num_bits, num_keys, len)) in SHAPES.iter().enumerate() {
        let keys: Vec<u64> = (0..num_keys).map(|_| r.next()).collect();
        let present = items(&mut r, 300, len);
        let absent = items(&mut r, 300, len);
        let mut b: Bloom<Vec<u8>> = Bloom::new(num_bits, keys.clone());
        let mut m = Model::new(num_bits, &keys);
        assert_same(&b, &m, "new");
        for (i, it) in present.iter().enumerate() {
            assert_eq!(b.contains(it), m.contains(it), "shape {si} item {i} before");
            b.add(it);
            m.add(it);
            assert!(b.contains(it), "shape {si} item {i}: added and not found");
            assert_eq!(b.num_bits_set(), m.ones(), "shape {si} item {i}");
            if i % 4 == 0 {
                // adding an item again changes nothing
                b.add(it);
                assert_eq!(b.num_bits_set(), m.ones(), "shape {si} item {i} again");
            }
        }
        assert_same(&b, &m, "filled");
        for (i, it) in absent.iter().enumerate() {
            assert_eq!(b.contains(it), m.contains(it), "shape {si} absent {i}");
        }
        let copy = b.clone();
        assert!(copy == b);
        b.clear();
        assert_same(&b, &Model::new(num_bits, &keys), "cleared");
        assert!(copy != b || m.ones() == 0);
        assert_eq!(b.keys, keys);
    }
}

#[test]
fn fixed_size_items_match_model() {
    let mut r = Rng(3);
    let keys: Vec<u64> = (0..5).map(|_| r.next()).collect();
    let mut b32: Bloom<[u8; 32]> = Bloom::new(9731, keys.clone());
    let mut b64: Bloom<[u8; 64]> = Bloom::new(9731, keys.clone());
    let mut m32 = Model::new(9731, &keys);
    let mut m64 = Model::new(9731, &keys);
    for _ in 0..500 {
        let mut a = [0u8; 32];
        a.copy_from_slice(&r.bytes(32));
        let mut s = [0u8; 64];
        s.copy_from_slice(&r.bytes(64));
        b32.add(&a);
        m32.add(&a);
        b64.add(&s);
        m64.add(&s);
        assert!(b32.contains(&a) && b64.contains(&s));
    }
    assert_same(&b32, &m32, "32-byte items");
    assert_same(&b64, &m64, "64-byte items");
}

#[test]
fn concurrent_bloom_matches_model() {
    let mut r = Rng(4);
    for (si, &(num_bits, num_keys, len)) in SHAPES.iter().enumerate() {
        let keys: Vec<u64> = (0..num_keys).map(|_| r.next()).collect();
        let present = items(&mut r, 300, len);
        let absent = items(&mut r, 300, len);
        let c: ConcurrentBloom<Vec<u8>> = Bloom::new(num_bits, keys.clone()).into();
        let mut m = Model::new(num_bits, &keys);
        for (i, it) in present.iter().enumerate() {
            assert_eq!(c.contains(it), m.contains(it), "shape {si} item {i} before");
            assert_eq!(c.add(it), m.add(it), "shape {si} item {i}: add's answer");
            assert!(c.contains(it));
            if i % 4 == 0 {
                assert!(!c.add(it), "shape {si} item {i}: second add set a bit");
            }
        }
        for (i, it) in absent.iter().enumerate() {
            assert_eq!(c.contains(it), m.contains(it), "shape {si} absent {i}");
        }
        // into a Bloom: same bits, the count recomputed
        let b: Bloom<Vec<u8>> = c.into();
        assert_same(&b, &m, "from concurrent");
        assert_eq!(b.keys, keys);
        // and back: the bits survive, more items land where the model puts them
        let c: ConcurrentBloom<Vec<u8>> = b.into();
        for it in &present {
            assert!(c.contains(it));
        }
        for it in &absent {
            assert_eq!(c.add(it), m.add(it));
        }
        let b: Bloom<Vec<u8>> = c.into();
        assert_same(&b, &m, "grown");
        let c: ConcurrentBloom<Vec<u8>> = b.into();
        c.clear();
        for it in present.iter().chain(absent.iter()) {
            assert!(!c.contains(it));
        }
        let b: Bloom<Vec<u8>> = c.into();
        assert_same(&b, &Model::new(num_bits, &keys), "cleared");
    }
}

#[test]
fn wire_form_round_trips() {
    let mut r = Rng(5);
    for &(num_bits, num_keys, len) in SHAPES {
        let keys: Vec<u64> = (0..num_keys).map(|_| r.next()).collect();
        let mut b: Bloom<Vec<u8>> = Bloom::new(num_bits, keys);
        for it in items(&mut r, 100, len) {
            b.add(&it);
        }
        let bin = bincode::serialize(&b).unwrap();
        let win = wincode::serialize(&b).unwrap();
        assert_eq!(bin, win);
        let from_bin: Bloom<Vec<u8>> = bincode::deserialize(&bin).unwrap();
        let from_win: Bloom<Vec<u8>> = wincode::deserialize(&win).unwrap();
        assert!(from_bin == b && from_win == b);
        assert_eq!(from_win.num_bits_set(), b.num_bits_set());
    }
}

#[test]
fn interval_filter_adds_and_finds() {
    let mut r = Rng(6);
    let f: ConcurrentBloomInterval<Vec<u8>> = ConcurrentBloomInterval::new(1000, 0.01, 100_000);
    let present = items(&mut r, 200, 32);
    for it in &present {
        f.add(it);
    }
    for it in &present {
        assert!(f.contains(it));
    }
    // a fresh interval never resets on its first check, whatever the interval
    f.maybe_reset(u64::MAX);
    for it in &present {
        assert!(f.contains(it));
    }
}
