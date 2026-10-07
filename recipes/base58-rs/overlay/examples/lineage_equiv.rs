// Lineage equivalence harness for debris/base58 (recipe overlay, protected).
// Usage: lineage_equiv <seed>
// Prints observable behaviour on seeded inputs and edge cases the upstream tests miss: empty and
// all-zero inputs, long leading-zero runs, lengths around the decoder's 128-byte limit, invalid
// ASCII and non-ASCII characters (error variant, character and index), and leading '1' runs.
// A perf patch must leave this output byte-identical.
extern crate base58;

#[path = "lineage_support/rng.rs"]
mod lineage_rng;

use base58::{FromBase58, ToBase58};
use std::env;

fn hex(v: &[u8]) -> String {
    v.iter().map(|b| format!("{:02x}", b)).collect()
}

// The decoder panics on some inputs (leading '1's plus a payload that fills its fixed 132-byte
// buffer: `leading_zeros - zcount` underflows). That is observable behaviour too, so it is
// caught and printed rather than allowed to abort the harness.
fn dec(label: &str, s: &str) {
    match std::panic::catch_unwind(|| s.from_base58()) {
        Ok(Ok(v)) => println!("{} ok {}", label, hex(&v)),
        Ok(Err(e)) => println!("{} err {:?}", label, e),
        Err(_) => println!("{} panic", label),
    }
}

fn main() {
    let seed = env::args().nth(1).unwrap_or_default();
    let mut r = lineage_rng::Rng::from_seed_str(&seed);
    std::panic::set_hook(Box::new(|_| {}));
    let mut inputs: Vec<Vec<u8>> = vec![vec![], vec![0], vec![0; 9], vec![0, 0, 1], vec![1], vec![255], vec![255; 33], vec![255; 128], vec![255; 129]];
    for z in 0..12 {
        let mut v = vec![0u8; z];
        v.extend_from_slice(&[1, 0]);
        inputs.push(v);
    }
    for _ in 0..400 {
        let n = [1usize, 2, 3, 5, 8, 20, 25, 32, 33, 64, 100, 127, 128, 129, 140, 200][r.below(16) as usize];
        let z = if r.below(4) == 0 { r.below(6) as usize } else { 0 };
        let mut v = vec![0u8; z];
        v.extend(r.bytes(n));
        inputs.push(v);
    }
    for (i, p) in inputs.iter().enumerate() {
        let e = p.to_base58();
        println!("enc {} {}", i, e);
        dec(&format!("dec {}", i), &e);
    }
    for (i, s) in ["", "1", "11111", "z", "1z", "0", "O", "I", "l", "+", " ", "2 ", "\u{e9}", "a\u{e9}b", "1\u{20ac}", "\u{20ac}1", "11\u{0}"].iter().enumerate() {
        dec(&format!("fixed {} {:?}", i, s), s);
    }
    // random strings over the alphabet plus a few invalid characters, various lengths
    let alpha: Vec<char> = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz0OIl!\u{e9}".chars().collect();
    for i in 0..300 {
        let n = r.below(200) as usize;
        let s: String = (0..n).map(|_| {
            let k = r.below(1000);
            if k < 990 { alpha[(k % 58) as usize] } else { alpha[58 + (k % 6) as usize] }
        }).collect();
        dec(&format!("rand {}", i), &s);
    }
}
