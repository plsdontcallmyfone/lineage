// Lineage benchmark harness for stainless-steel/md5 (recipe overlay, protected).
// Usage: lineage_bench <hash|hex> <seed>
// Prints a checksum of all outputs so the work cannot be optimised away. Measured with cachegrind
// instruction counts; inputs depend only on the seed.
//   hash: MD5 of 1500 seeded messages from 0 to 4 KB, one-shot and streamed in seeded chunks
//   hex:  md5 the way most callers use it, format!("{:x}", md5::compute(data)), over 4000 short
//         seeded messages (cache keys, ETags, content ids of 0 to 120 bytes)
#[path = "lineage_support/rng.rs"]
mod lineage_rng;

use md5::{compute, Context};
use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();
    let mode = args.get(1).expect("usage: lineage_bench <hash|hex> <seed>");
    let seed = args.get(2).expect("seed");
    let mut r = lineage_rng::Rng::from_seed_str(seed);
    let mut sum: u64 = 0;
    match mode.as_str() {
        "hash" => {
            for _ in 0..1500 {
                let n = r.below(4096) as usize;
                let m = r.bytes(n);
                let d = compute(&m);
                let mut c = Context::new();
                let mut rest = &m[..];
                while !rest.is_empty() {
                    let take = core::cmp::min(rest.len(), 1 + r.below(300) as usize);
                    c.consume(&rest[..take]);
                    rest = &rest[take..];
                }
                let e = c.finalize();
                for b in d.0.iter().chain(e.0.iter()) {
                    sum = sum.wrapping_mul(131).wrapping_add(*b as u64);
                }
            }
        }
        "hex" => {
            for _ in 0..4000 {
                let n = r.below(121) as usize;
                let m = r.bytes(n);
                let s = format!("{:x}", compute(&m));
                for b in s.bytes() {
                    sum = sum.wrapping_mul(131).wrapping_add(b as u64);
                }
            }
        }
        other => panic!("unknown mode {}", other),
    }
    println!("{} {:016x}", mode, sum);
}
