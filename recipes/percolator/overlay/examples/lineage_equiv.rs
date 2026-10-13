// Lineage equivalence harness for the percolator v16 risk engine (recipe overlay, protected).
// Usage: lineage_equiv <seed>
// This is a risk engine: a patch may make it cheaper and may not change one answer or one byte of
// state. The harness prints, on seeded inputs:
//   engine  WORLDS market groups (lineage_support/sim.rs: four configuration profiles, 1 to 4
//           assets, money from small integers up to the engine's limits) with OPS wrapper
//           transactions each and their resolution. For every engine call: its full answer (the Ok
//           value in Debug form, or which error, or that it panicked). After every transaction:
//           whether it was committed and a digest of every byte of state (the group header, each
//           asset slot, each account: all of them plain-old-data account images).
//   wide    CALLS calls of the checked arithmetic helpers (lineage_support/wide.rs) with their
//           full results: the wide multiply-divide in both rounding directions against edge and
//           random operands, notional, fees, ADL quantities, loss weights, the price-cap step.
// What a refused call left behind before the rollback is not printed: the engine's contract leaves
// it to the caller's rollback (README, "an Err must not commit partial mutation").
// The text is tens of megabytes, more than a sandbox captures, so the harness digests it itself and
// prints one line per world and one per thousand arithmetic calls: the number of lines and a digest
// of all of them. `lineage_equiv <seed> --full` prints the text itself (to compare two builds by hand).
#[path = "lineage_support/rng.rs"]
mod lineage_rng;
#[path = "lineage_support/sim.rs"]
mod sim;
#[path = "lineage_support/wide.rs"]
mod wide;

use percolator::V16Result;
use std::env;
use std::fmt::Debug;
use std::io::{BufWriter, Write};

const WORLDS: usize = 64;
const OPS: usize = 400;
const CALLS: usize = 120_000;

/// Two independent 64-bit FNV-1a style digests (different offsets and primes), printed together.
struct Digest(u64, u64);

impl Digest {
    fn new() -> Digest {
        Digest(0xcbf29ce484222325, 0x9e3779b97f4a7c15)
    }
    fn bytes(&mut self, b: &[u8]) {
        for &x in b {
            self.0 = (self.0 ^ x as u64).wrapping_mul(0x100000001b3);
            self.1 = (self.1 ^ x as u64).wrapping_mul(0xff51afd7ed558ccd).rotate_left(23);
        }
    }
}

/// Digests every line written to it; with `full` it also prints them.
struct Lines {
    d: Digest,
    count: u64,
    full: Option<BufWriter<std::io::Stdout>>,
}

impl Lines {
    fn line(&mut self, text: &str) {
        self.d.bytes(text.as_bytes());
        self.d.bytes(b"\n");
        self.count += 1;
        if let Some(out) = self.full.as_mut() {
            writeln!(out, "{}", text).unwrap();
        }
    }
    /// Prints the digest of the lines since the last section and starts the next one.
    fn section(&mut self, name: &str) {
        println!("{} {} {:016x}{:016x}", name, self.count, self.d.0, self.d.1);
        self.d = Digest::new();
        self.count = 0;
    }
}

struct Printer {
    out: Lines,
    calls: Vec<String>,
}

impl sim::Rec for Printer {
    fn call<T: Debug>(&mut self, tag: &'static str, r: &Result<V16Result<T>, ()>) {
        self.calls.push(match r {
            Ok(Ok(v)) => format!("{tag}={v:?}"),
            Ok(Err(e)) => format!("{tag}!{e:?}"),
            Err(()) => format!("{tag}!PANIC"),
        });
    }
    fn op_end(&mut self, index: usize, committed: bool, w: &sim::World) {
        let mut d = Digest::new();
        w.state_bytes(|b| d.bytes(b));
        let text = format!("{} {} {:016x}{:016x} {}", index, if committed { "ok" } else { "rb" }, d.0, d.1, self.calls.join(" "));
        self.out.line(&text);
        self.calls.clear();
    }
}

fn main() {
    // a panic inside the library is an answer like any other; keep its message off the terminal
    std::panic::set_hook(Box::new(|_| {}));
    let seed = env::args().nth(1).unwrap_or_else(|| "0".to_string());
    let full = env::args().nth(2).as_deref() == Some("--full");
    let mut r = lineage_rng::Rng::from_seed_str(&seed);
    let mut p = Printer { out: Lines { d: Digest::new(), count: 0, full: full.then(|| BufWriter::new(std::io::stdout())) }, calls: Vec::new() };
    for i in 0..WORLDS {
        let shape = sim::shape(&mut r, i);
        let ops = sim::ops(&mut r, &shape, OPS);
        p.out.line(&format!("world {} {:?}", i, shape));
        let mut w = sim::world(&shape, &mut p);
        let setup = format!("setup {}", p.calls.join(" "));
        p.out.line(&setup);
        p.calls.clear();
        for (j, op) in ops.iter().enumerate() {
            w.exec(j, op, false, &mut p);
        }
        if !full {
            p.out.section(&format!("world {}", i));
        }
    }
    for i in 0..CALLS {
        let op = wide::equiv_op(&mut r);
        let text = match wide::apply(op) {
            Ok(Ok(v)) => format!("w{} {:?} = {:?}", i, op, v),
            Ok(Err(e)) => format!("w{} {:?} ! {:?}", i, op, e),
            Err(()) => format!("w{} {:?} ! PANIC", i, op),
        };
        p.out.line(&text);
        if !full && (i + 1) % 1000 == 0 {
            p.out.section(&format!("wide {}", i + 1));
        }
    }
    if let Some(out) = p.out.full.as_mut() {
        out.flush().unwrap();
    }
}
