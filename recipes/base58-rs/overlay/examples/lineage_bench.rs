// Lineage benchmark harness for debris/base58 (recipe overlay, protected).
// Usage: lineage_bench <encode|decode> <seed>
// Prints a checksum of all outputs so the work cannot be optimised away. Measured with cachegrind
// instruction counts; inputs depend only on the seed.
// Workload: Solana public keys (32 bytes) and signatures (64 bytes), Bitcoin payloads (25 bytes),
// inputs with leading zero bytes, and a few longer blobs. The crate's decoder only accepts
// outputs up to 128 bytes, so decode inputs stay within that.
extern crate base58;

#[path = "lineage_support/rng.rs"]
mod lineage_rng;

use base58::{FromBase58, ToBase58};
use std::env;

fn payloads(r: &mut lineage_rng::Rng, max_len: usize) -> Vec<Vec<u8>> {
    let mut out = Vec::new();
    for _ in 0..600 {
        out.push(r.bytes(32));
    }
    for _ in 0..250 {
        out.push(r.bytes(64));
    }
    for _ in 0..150 {
        let z = 1 + r.below(4) as usize;
        let mut v = vec![0u8; z];
        let n = [20usize, 24, 31, 32][r.below(4) as usize];
        v.extend(r.bytes(n));
        out.push(v);
    }
    for _ in 0..12 {
        let n = [100usize, 128, 200, 256][r.below(4) as usize].min(max_len);
        out.push(r.bytes(n));
    }
    out
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("encode");
    let seed = args.get(2).cloned().unwrap_or_default();
    let mut r = lineage_rng::Rng::from_seed_str(&seed);
    let mut acc: u64 = 0xcbf29ce484222325;
    let mut mix = |bytes: &[u8]| {
        for &b in bytes {
            acc ^= b as u64;
            acc = acc.wrapping_mul(0x100000001b3);
        }
    };
    match mode {
        "encode" => {
            let data = payloads(&mut r, 256);
            for _ in 0..10 {
                for p in &data {
                    mix(p.to_base58().as_bytes());
                }
            }
        }
        "decode" => {
            let data = payloads(&mut r, 128);
            let enc: Vec<String> = data.iter().map(|p| p.to_base58()).collect();
            for _ in 0..10 {
                for e in &enc {
                    mix(&e.from_base58().unwrap());
                }
            }
        }
        m => panic!("unknown mode {}", m),
    }
    println!("{} {:016x}", mode, acc);
}
