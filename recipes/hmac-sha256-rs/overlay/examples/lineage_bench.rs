// Lineage benchmark harness for jedisct1/rust-hmac-sha256 (recipe overlay, protected).
// Usage: lineage_bench <hash|hmac|hkdf> <seed>
// Prints a checksum of all outputs so the work cannot be optimised away. Measured with cachegrind
// instruction counts; inputs depend only on the seed.
//   hash: SHA-256 of seeded messages from 0 to 2 KB (one-shot and streamed in seeded chunks)
//   hmac: HMAC-SHA256 with keys of 0 to 100 bytes (some longer than the block) over short and
//         medium messages, one-shot and incremental
//   hkdf: HKDF-SHA256 extract, then expand to 32 to 1024 bytes of output key material
#[path = "lineage_support/rng.rs"]
mod lineage_rng;

use hmac_sha256::{Hash, HKDF, HMAC};
use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();
    let mode = args.get(1).expect("usage: lineage_bench <hash|hmac|hkdf> <seed>");
    let seed = args.get(2).expect("seed");
    let mut r = lineage_rng::Rng::from_seed_str(seed);
    let mut sum: u64 = 0;
    let mut fold = |d: &[u8]| {
        for &b in d {
            sum = sum.wrapping_mul(131).wrapping_add(b as u64);
        }
    };
    match mode.as_str() {
        "hash" => {
            for _ in 0..300 {
                let n = r.below(2048) as usize;
                let m = r.bytes(n);
                fold(&Hash::hash(&m));
                let mut h = Hash::new();
                let mut rest = &m[..];
                while !rest.is_empty() {
                    let take = core::cmp::min(rest.len(), 1 + r.below(200) as usize);
                    h.update(&rest[..take]);
                    rest = &rest[take..];
                }
                fold(&h.finalize());
            }
        }
        "hmac" => {
            for _ in 0..1500 {
                let key = { let n = r.below(100) as usize; r.bytes(n) };
                let m = { let n = r.below(160) as usize; r.bytes(n) };
                fold(&HMAC::mac(&m, &key));
                let mut s = HMAC::new(&key);
                s.update(&m[..m.len() / 2]);
                s.update(&m[m.len() / 2..]);
                fold(&s.finalize());
            }
        }
        "hkdf" => {
            for _ in 0..200 {
                let salt = { let n = r.below(64) as usize; r.bytes(n) };
                let ikm = { let n = 16 + r.below(48) as usize; r.bytes(n) };
                let info = { let n = r.below(40) as usize; r.bytes(n) };
                let prk = HKDF::extract(&salt, &ikm);
                let n = 32 + r.below(993) as usize;
                let mut okm = vec![0u8; n];
                HKDF::expand(&mut okm, prk, &info);
                fold(&okm);
            }
        }
        other => panic!("unknown mode {}", other),
    }
    println!("{} {:016x}", mode, sum);
}
