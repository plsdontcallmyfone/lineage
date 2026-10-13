// Lineage benchmark harness for the percolator v16 risk engine (recipe overlay, protected).
// Usage: lineage_bench <engine|wide> <seed> [--inputs-only]
// Prints a checksum of every answer and of the final state so the work cannot be optimised away.
// Measured with cachegrind instruction counts; inputs depend only on the seed. One thread, no
// clock, no OS randomness.
//   engine  WORLDS market groups of 1, 2 or 4 assets with six accounts each, OPS wrapper
//           transactions per group (oracle steps with a keeper's crank sweep, deposits,
//           withdrawals, trades and batches, refreshes, liquidations, rebalances, conversions,
//           fee syncs, insurance), then resolution and the closing of every account. See
//           lineage_support/sim.rs. A refused transaction is rolled back, as the engine's contract
//           says its caller does.
//   wide    CALLS calls of the checked arithmetic helpers the engine reaches src/wide_math.rs
//           through, most of them with products past 128 bits. See lineage_support/wide.rs.
// --inputs-only draws the same inputs, saves the same rollback copies and mixes the same state
// bytes, and makes no call into the library: that count is what in a metric is not the engine's
// work, except the copies back after a refused transaction (which transactions are refused is
// the engine's answer, so a run without the engine cannot make them).
#[path = "lineage_support/rng.rs"]
mod lineage_rng;
#[path = "lineage_support/sim.rs"]
mod sim;
#[path = "lineage_support/wide.rs"]
mod wide;

use percolator::V16Result;
use std::env;
use std::fmt::Debug;

const WORLDS: usize = 24;
const OPS: usize = 320;
const CALLS: usize = 60_000;

struct Acc(u64);

impl Acc {
    fn mix(&mut self, v: u64) {
        self.0 ^= v;
        self.0 = self.0.wrapping_mul(0x100000001b3);
    }
    fn bytes(&mut self, b: &[u8]) {
        let mut chunks = b.chunks_exact(8);
        for c in &mut chunks {
            self.mix(u64::from_le_bytes([c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7]]));
        }
        for &x in chunks.remainder() {
            self.mix(x as u64);
        }
    }
}

impl sim::Rec for Acc {
    fn call<T: Debug>(&mut self, tag: &'static str, r: &Result<V16Result<T>, ()>) {
        self.mix(tag.len() as u64);
        self.mix(match r {
            Ok(Ok(_)) => 0,
            Ok(Err(e)) => 1 + *e as u64,
            Err(()) => 99,
        });
    }
    fn op_end(&mut self, _index: usize, committed: bool, w: &sim::World) {
        self.mix(committed as u64);
        self.mix(w.header.vault.get() as u64);
        self.mix(w.header.c_tot.get() as u64);
    }
}

fn engine(seed: &str, dry: bool) -> u64 {
    let mut r = lineage_rng::Rng::from_seed_str(seed);
    let mut acc = Acc(0xcbf29ce484222325);
    for i in 0..WORLDS {
        let shape = sim::shape(&mut r, i);
        let ops = sim::ops(&mut r, &shape, OPS);
        let mut w = if dry { sim::blank(&shape) } else { sim::world(&shape, &mut acc) };
        for (j, op) in ops.iter().enumerate() {
            w.exec(j, op, dry, &mut acc);
        }
        let mut bytes = Acc(acc.0);
        w.state_bytes(|b| bytes.bytes(b));
        acc.0 = bytes.0;
    }
    acc.0
}

fn wide_calls(seed: &str, dry: bool) -> u64 {
    let mut r = lineage_rng::Rng::from_seed_str(seed);
    let ops: Vec<wide::WideOp> = (0..CALLS).map(|_| wide::bench_op(&mut r)).collect();
    let mut acc = Acc(0xcbf29ce484222325);
    for op in &ops {
        if dry {
            acc.mix(1);
            continue;
        }
        match wide::apply(*op) {
            Ok(Ok(v)) => {
                for x in v {
                    acc.mix(x as u64);
                    acc.mix((x >> 64) as u64);
                }
            }
            Ok(Err(e)) => acc.mix(1 + e as u64),
            Err(()) => acc.mix(99),
        }
    }
    acc.0
}

fn main() {
    // a panic inside the library is an answer like any other; keep its message off the terminal
    std::panic::set_hook(Box::new(|_| {}));
    let args: Vec<String> = env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("");
    let seed = args.get(2).map(String::as_str).unwrap_or("0");
    let dry = args.get(3).map(String::as_str) == Some("--inputs-only");
    let sum = match mode {
        "engine" => engine(seed, dry),
        "wide" => wide_calls(seed, dry),
        _ => {
            eprintln!("usage: lineage_bench <engine|wide> <seed> [--inputs-only]");
            std::process::exit(2);
        }
    };
    println!("{} {:016x}", mode, sum);
}
