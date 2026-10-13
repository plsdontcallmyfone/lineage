// Lineage equivalence harness for solana-bloom in gorbagana-chain (recipe overlay, protected).
// Usage: lineage_equiv <seed>
// Prints every public result on seeded inputs: the bits, the set-bit count, every lookup, the
// Debug text, the bincode and wincode bytes (the filter travels in gossip, so its wire form is
// part of its behaviour) and both decodings, the ConcurrentBloom answers and both conversions,
// and the sizes Bloom::random picks (its keys are random, their count is not).
// Shapes include the edges: no bits, one bit, lengths around the 64-bit block boundary and around
// the ten bits Debug prints, no keys, keys 0 and u64::MAX, empty items.
#[path = "lineage_support/rng.rs"]
mod lineage_rng;

use bv::Bits;
use solana_bloom::bloom::{Bloom, BloomHashIndex, ConcurrentBloom};
use std::env;

fn fnv(acc: &mut u64, bytes: &[u8]) {
    for &b in bytes {
        *acc ^= b as u64;
        *acc = acc.wrapping_mul(0x100000001b3);
    }
}

fn bits_digest<T: BloomHashIndex>(b: &Bloom<T>) -> String {
    let mut acc = 0xcbf29ce484222325u64;
    for i in 0..b.bits.block_len() {
        fnv(&mut acc, &b.bits.get_block(i).to_le_bytes());
    }
    let mut ones = 0u64;
    for i in 0..b.bits.len() {
        ones += b.bits.get(i) as u64;
    }
    format!("{} {} {} {:016x}", b.bits.len(), b.bits.block_len(), ones, acc)
}

fn bytes_digest(bytes: &[u8]) -> String {
    let mut acc = 0xcbf29ce484222325u64;
    fnv(&mut acc, bytes);
    format!("{}:{:016x}", bytes.len(), acc)
}

fn shape(r: &mut lineage_rng::Rng, i: usize) -> (usize, Vec<u64>) {
    const EDGE_BITS: [usize; 20] = [0, 1, 2, 3, 9, 10, 11, 63, 64, 65, 127, 128, 129, 191, 192, 193, 1000, 4096, 6168, 9731];
    let bits = if i < 40 { EDGE_BITS[i % 20] } else { 1 + r.below(70_000) as usize };
    let nkeys = if i % 7 == 3 { 0 } else { 1 + r.below(10) as usize };
    let mut keys: Vec<u64> = (0..nkeys).map(|_| r.next()).collect();
    if i % 5 == 0 && !keys.is_empty() {
        keys[0] = 0;
    }
    if i % 5 == 1 && !keys.is_empty() {
        let last = keys.len() - 1;
        keys[last] = u64::MAX;
    }
    (bits, keys)
}

fn item(r: &mut lineage_rng::Rng, kind: usize) -> Vec<u8> {
    let n = match kind {
        0 => 32,
        1 => 64,
        2 => r.below(9) as usize,
        _ => r.below(200) as usize,
    };
    r.bytes(n)
}

fn scenario(r: &mut lineage_rng::Rng, i: usize) {
    let (nbits, keys) = shape(r, i);
    let kind = i % 4;
    let nitems = if nbits < 200 { r.below(12) as usize } else { 1 + r.below(400) as usize };
    let items: Vec<Vec<u8>> = (0..nitems).map(|_| item(r, kind)).collect();
    let absent: Vec<Vec<u8>> = (0..nitems + 4).map(|_| item(r, kind)).collect();

    let mut b: Bloom<Vec<u8>> = Bloom::new(nbits, keys.clone());
    println!("new {} {} {} {}", i, keys.len(), b.num_bits_set(), bits_digest(&b));
    let mut trace = 0xcbf29ce484222325u64;
    for (j, it) in items.iter().enumerate() {
        let before = b.contains(it);
        b.add(it);
        let after = b.contains(it);
        fnv(&mut trace, &[before as u8, after as u8]);
        fnv(&mut trace, &b.num_bits_set().to_le_bytes());
        if j % 3 == 0 {
            b.add(it);
            fnv(&mut trace, &b.num_bits_set().to_le_bytes());
        }
    }
    let present: String = items.iter().map(|it| if b.contains(it) { '1' } else { '0' }).collect();
    let missing: String = absent.iter().map(|it| if b.contains(it) { '1' } else { '0' }).collect();
    println!("add {} {} {:016x} {}", i, b.num_bits_set(), trace, bits_digest(&b));
    println!("has {} {} {}", i, bytes_digest(present.as_bytes()), bytes_digest(missing.as_bytes()));
    println!("dbg {} {:?}", i, b);

    let bin = bincode::serialize(&b).unwrap();
    let win = wincode::serialize(&b).unwrap();
    let from_bin: Bloom<Vec<u8>> = bincode::deserialize(&bin).unwrap();
    let from_win: Bloom<Vec<u8>> = wincode::deserialize(&win).unwrap();
    println!(
        "ser {} {} {} {} {} {}",
        i,
        bytes_digest(&bin),
        bytes_digest(&win),
        from_bin == b,
        from_win == b,
        bits_digest(&from_win)
    );
    let cloned = b.clone();
    println!("eq {} {} {}", i, cloned == b, cloned.keys == keys);

    // the same items through the concurrent filter, then back
    let c: ConcurrentBloom<Vec<u8>> = Bloom::new(nbits, keys.clone()).into();
    let mut ctrace = 0xcbf29ce484222325u64;
    for (j, it) in items.iter().enumerate() {
        let before = c.contains(it);
        let fresh = c.add(it);
        let after = c.contains(it);
        fnv(&mut ctrace, &[before as u8, fresh as u8, after as u8]);
        if j % 3 == 0 {
            fnv(&mut ctrace, &[c.add(it) as u8]);
        }
    }
    let cmissing: String = absent.iter().map(|it| if c.contains(it) { '1' } else { '0' }).collect();
    let back: Bloom<Vec<u8>> = c.into();
    println!(
        "con {} {:016x} {} {} {} {}",
        i,
        ctrace,
        bytes_digest(cmissing.as_bytes()),
        back.num_bits_set(),
        back == b,
        bits_digest(&back)
    );
    // a filled Bloom into a ConcurrentBloom keeps its bits; more items; cleared
    let c: ConcurrentBloom<Vec<u8>> = b.clone().into();
    let kept: String = items.iter().map(|it| if c.contains(it) { '1' } else { '0' }).collect();
    let mut more = 0u64;
    for it in &absent {
        more = (more << 1) ^ (c.add(it) as u64);
    }
    let grown: Bloom<Vec<u8>> = c.into();
    println!("grow {} {} {:016x} {} {}", i, bytes_digest(kept.as_bytes()), more, grown.num_bits_set(), bits_digest(&grown));
    let c: ConcurrentBloom<Vec<u8>> = grown.into();
    c.clear();
    let any: bool = items.iter().chain(absent.iter()).any(|it| c.contains(it));
    let empty: Bloom<Vec<u8>> = c.into();
    println!("clr {} {} {} {}", i, any, empty.num_bits_set(), bits_digest(&empty));
    b.clear();
    println!("clr2 {} {} {} {:?}", i, b.num_bits_set(), bits_digest(&b), b);
}

fn main() {
    let seed = env::args().nth(1).expect("usage: lineage_equiv <seed>");
    let mut r = lineage_rng::Rng::from_seed_str(&seed);
    for i in 0..160usize {
        scenario(&mut r, i);
    }
    // fixed-size items through the blanket impl, as the validator uses them (Hash, Signature)
    for i in 0..40usize {
        let (nbits, keys) = shape(&mut r, 40 + i);
        let mut b32: Bloom<[u8; 32]> = Bloom::new(nbits, keys.clone());
        let mut b64: Bloom<[u8; 64]> = Bloom::new(nbits, keys.clone());
        let mut probe = 0xcbf29ce484222325u64;
        for _ in 0..200 {
            let mut a = [0u8; 32];
            let mut s = [0u8; 64];
            a.copy_from_slice(&r.bytes(32));
            s.copy_from_slice(&r.bytes(64));
            b32.add(&a);
            b64.add(&s);
            for k in keys.iter().take(2) {
                fnv(&mut probe, &a.hash_at_index(*k).to_le_bytes());
                fnv(&mut probe, &s.hash_at_index(*k).to_le_bytes());
            }
        }
        println!("fix {} {:016x} {} {} {} {}", i, probe, b32.num_bits_set(), bits_digest(&b32), b64.num_bits_set(), bits_digest(&b64));
    }
    // Bloom::random: the bit length and the number of keys follow from the arguments alone
    for i in 0..120usize {
        let items = [0usize, 1, 2, 10, 100, 1287, 5000][i % 7] + if i >= 60 { r.below(3000) as usize } else { 0 };
        let rate = [0.1f64, 0.01, 0.5, 0.001, 0.25][i % 5];
        let max_bits = [1usize, 100, 928, 7424, 100_000][(i / 5) % 5] + if i >= 60 { r.below(5000) as usize } else { 0 };
        let b: Bloom<[u8; 32]> = Bloom::random(items, rate, max_bits);
        println!("rnd {} {} {} {} {} {} {}", i, items, rate, max_bits, b.keys.len(), b.bits.len(), b.num_bits_set());
    }
}
