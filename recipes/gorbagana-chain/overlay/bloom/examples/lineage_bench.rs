// Lineage benchmark harness for solana-bloom in gorbagana-chain (recipe overlay, protected).
// Usage: lineage_bench <add|contains|concurrent> <seed> [--inputs-only]
// Prints a checksum of every result so the work cannot be optimised away. Measured with cachegrind
// instruction counts; inputs depend only on the seed. One thread, no clock, no OS randomness
// (filters are built with Bloom::new and seeded keys, never Bloom::random).
// Workload, after the filter's uses in the validator:
//   small  24 gossip-sized filters (4,000 to 60,000 bits, 3 to 5 keys) over 32-byte hashes
//   big    one signature-status-sized filter (3 to 4 million bits, 27 keys) over 64-byte signatures
//   var    one filter (20,000 to 200,000 bits, 5 to 8 keys) over items of 1 to 96 bytes
// Bit lengths are odd, so positions are never a plain mask of the hash.
// --inputs-only builds the same inputs and filters and stops before the first library call that
// hashes an item: that count is everything in a metric that is not the filter's work.
#[path = "lineage_support/rng.rs"]
mod lineage_rng;

use bv::Bits;
use solana_bloom::bloom::{Bloom, ConcurrentBloom};
use std::env;

const SMALL_FILTERS: usize = 24;
const SMALL_ITEMS: usize = 1500;
const BIG_ITEMS: usize = 6000;
const VAR_ITEMS: usize = 8000;

struct Inputs {
    small_shapes: Vec<(usize, Vec<u64>)>,
    small: Vec<[u8; 32]>,
    small_absent: Vec<[u8; 32]>,
    big_shape: (usize, Vec<u64>),
    big: Vec<[u8; 64]>,
    big_absent: Vec<[u8; 64]>,
    var_shape: (usize, Vec<u64>),
    var: Vec<Vec<u8>>,
    var_absent: Vec<Vec<u8>>,
}

fn arr<const N: usize>(r: &mut lineage_rng::Rng) -> [u8; N] {
    let mut a = [0u8; N];
    for chunk in a.chunks_mut(8) {
        let w = r.next().to_le_bytes();
        chunk.copy_from_slice(&w[..chunk.len()]);
    }
    a
}

fn keys(r: &mut lineage_rng::Rng, n: usize) -> Vec<u64> {
    (0..n).map(|_| r.next()).collect()
}

fn inputs(r: &mut lineage_rng::Rng) -> Inputs {
    let small_shapes = (0..SMALL_FILTERS)
        .map(|_| {
            let bits = (4_000 + r.below(56_000) as usize) | 1;
            let k = 3 + r.below(3) as usize;
            (bits, keys(r, k))
        })
        .collect();
    let small = (0..SMALL_ITEMS).map(|_| arr::<32>(r)).collect();
    let small_absent = (0..SMALL_ITEMS).map(|_| arr::<32>(r)).collect();
    let big_shape = ((3_000_000 + r.below(1_000_000) as usize) | 1, keys(r, 27));
    let big = (0..BIG_ITEMS).map(|_| arr::<64>(r)).collect();
    let big_absent = (0..BIG_ITEMS).map(|_| arr::<64>(r)).collect();
    let var_bits = (20_000 + r.below(180_000) as usize) | 1;
    let var_keys = 5 + r.below(4) as usize;
    let var_shape = (var_bits, keys(r, var_keys));
    let var_item = |r: &mut lineage_rng::Rng| {
        let n = 1 + r.below(96) as usize;
        r.bytes(n)
    };
    let var = (0..VAR_ITEMS).map(|_| var_item(r)).collect();
    let var_absent = (0..VAR_ITEMS).map(|_| var_item(r)).collect();
    Inputs { small_shapes, small, small_absent, big_shape, big, big_absent, var_shape, var, var_absent }
}

struct Acc(u64);

impl Acc {
    fn mix(&mut self, v: u64) {
        self.0 ^= v;
        self.0 = self.0.wrapping_mul(0x100000001b3);
    }
    fn bloom<T: solana_bloom::bloom::BloomHashIndex>(&mut self, b: &Bloom<T>) {
        self.mix(b.num_bits_set());
        self.mix(b.bits.len());
        for i in 0..b.bits.block_len() {
            self.mix(b.bits.get_block(i));
        }
    }
}

// Every item is added once, then the first third is added again (a filter mostly sees items it
// already holds when it dedups), so both sides of the already-set branch are measured.
fn fill<T: AsRef<[u8]>>(b: &mut Bloom<T>, items: &[T]) {
    for it in items {
        b.add(it);
    }
    for it in &items[..items.len() / 3] {
        b.add(it);
    }
}

fn run_add(inp: &Inputs, acc: &mut Acc, inputs_only: bool) {
    for (bits, k) in &inp.small_shapes {
        let mut b: Bloom<[u8; 32]> = Bloom::new(*bits, k.clone());
        if !inputs_only {
            fill(&mut b, &inp.small);
            fill(&mut b, &inp.small_absent);
        }
        acc.bloom(&b);
    }
    let mut b: Bloom<[u8; 64]> = Bloom::new(inp.big_shape.0, inp.big_shape.1.clone());
    if !inputs_only {
        fill(&mut b, &inp.big);
    }
    acc.bloom(&b);
    let mut b: Bloom<Vec<u8>> = Bloom::new(inp.var_shape.0, inp.var_shape.1.clone());
    if !inputs_only {
        for _ in 0..3 {
            fill(&mut b, &inp.var);
            b.clear();
        }
        fill(&mut b, &inp.var);
    }
    acc.bloom(&b);
}

// Queries: every present item and as many absent ones per round. A present item costs every key,
// an absent one stops at its first unset bit.
fn query<T: AsRef<[u8]>>(b: &Bloom<T>, present: &[T], absent: &[T], rounds: usize, acc: &mut Acc) {
    let mut hits = 0u64;
    for _ in 0..rounds {
        for it in present {
            hits += b.contains(it) as u64;
        }
        for it in absent {
            hits += b.contains(it) as u64;
        }
    }
    acc.mix(hits);
}

fn run_contains(inp: &Inputs, acc: &mut Acc, inputs_only: bool) {
    // half as many filters as the add workload, each asked four rounds: lookups dominate the count
    for (bits, k) in inp.small_shapes.iter().take(SMALL_FILTERS / 2) {
        let mut b: Bloom<[u8; 32]> = Bloom::new(*bits, k.clone());
        if !inputs_only {
            for it in &inp.small {
                b.add(it);
            }
            query(&b, &inp.small, &inp.small_absent, 4, acc);
        }
        acc.mix(b.num_bits_set());
    }
    let mut b: Bloom<[u8; 64]> = Bloom::new(inp.big_shape.0, inp.big_shape.1.clone());
    if !inputs_only {
        for it in &inp.big[..BIG_ITEMS / 4] {
            b.add(it);
        }
        query(&b, &inp.big[..BIG_ITEMS / 4], &inp.big_absent, 4, acc);
    }
    acc.mix(b.num_bits_set());
    let mut b: Bloom<Vec<u8>> = Bloom::new(inp.var_shape.0, inp.var_shape.1.clone());
    if !inputs_only {
        for it in &inp.var {
            b.add(it);
        }
        query(&b, &inp.var, &inp.var_absent, 4, acc);
    }
    acc.mix(b.num_bits_set());
}

fn concurrent<T: AsRef<[u8]>>(bits: usize, k: &[u64], present: &[T], absent: &[T], acc: &mut Acc, inputs_only: bool) {
    let c: ConcurrentBloom<T> = Bloom::new(bits, k.to_vec()).into();
    if inputs_only {
        let b: Bloom<T> = c.into();
        acc.bloom(&b);
        return;
    }
    let mut fresh = 0u64;
    for it in present {
        fresh += c.add(it) as u64;
    }
    for it in &present[..present.len() / 3] {
        fresh += c.add(it) as u64;
    }
    let mut hits = 0u64;
    for it in present {
        hits += c.contains(it) as u64;
    }
    for it in absent {
        hits += c.contains(it) as u64;
    }
    acc.mix(fresh);
    acc.mix(hits);
    // the round trip the validator makes when it ships a filter: atomic words back into a Bloom
    let b: Bloom<T> = c.into();
    acc.bloom(&b);
    let c: ConcurrentBloom<T> = b.into();
    c.clear();
    acc.mix(c.contains(&present[0]) as u64);
}

fn run_concurrent(inp: &Inputs, acc: &mut Acc, inputs_only: bool) {
    for (bits, k) in &inp.small_shapes {
        concurrent(*bits, k, &inp.small, &inp.small_absent, acc, inputs_only);
    }
    concurrent(inp.big_shape.0, &inp.big_shape.1, &inp.big[..BIG_ITEMS / 2], &inp.big_absent[..BIG_ITEMS / 2], acc, inputs_only);
    concurrent(inp.var_shape.0, &inp.var_shape.1, &inp.var, &inp.var_absent, acc, inputs_only);
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("add");
    let seed = args.get(2).cloned().unwrap_or_default();
    let inputs_only = args.iter().any(|a| a == "--inputs-only");
    let mut r = lineage_rng::Rng::from_seed_str(&seed);
    let inp = inputs(&mut r);
    let mut acc = Acc(0xcbf29ce484222325);
    match mode {
        "add" => run_add(&inp, &mut acc, inputs_only),
        "contains" => run_contains(&inp, &mut acc, inputs_only),
        "concurrent" => run_concurrent(&inp, &mut acc, inputs_only),
        m => panic!("unknown mode {}", m),
    }
    println!("{} {:016x}", mode, acc.0);
}
