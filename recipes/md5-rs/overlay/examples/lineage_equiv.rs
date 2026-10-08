// Lineage equivalence harness for stainless-steel/md5 (recipe overlay, protected).
// Usage: lineage_equiv <seed>
// Prints, for seeded messages of every length class (0 to 5000 bytes), the digest one-shot, streamed
// in seeded chunks (including empty ones) and through io::Write, plus every formatting of it: lower
// and upper hex, Debug, and the formatter flags callers pass (#, width, fill, precision).
#[path = "lineage_support/rng.rs"]
mod lineage_rng;

use md5::{compute, Context, Digest};
use std::env;
use std::io::Write;

fn main() {
    let seed = env::args().nth(1).expect("usage: lineage_equiv <seed>");
    let mut r = lineage_rng::Rng::from_seed_str(&seed);
    for i in 0..500usize {
        let n = if i < 200 { i } else { r.below(5000) as usize };
        let m = r.bytes(n);
        let d = compute(&m);
        let mut c = Context::new();
        let mut w = Context::default();
        let mut rest = &m[..];
        while !rest.is_empty() || r.below(4) == 0 {
            let take = core::cmp::min(rest.len(), r.below(150) as usize);
            c.consume(&rest[..take]);
            w.write_all(&rest[..take]).unwrap();
            rest = &rest[take..];
            if rest.is_empty() {
                break;
            }
        }
        let e: Digest = c.clone().finalize();
        let f = Digest::from(w);
        let raw: [u8; 16] = d.into();
        println!(
            "{} {:x} {:X} {:?} {:#x} {:>40x} {:<36X}| {:.4x} {:x} {:x} {:?} {}",
            n, d, d, d, d, d, d, d, e, f, raw, d == e && e == f
        );
    }
}
