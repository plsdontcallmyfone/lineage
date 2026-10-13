// Lineage benchmark harness for solana-secp256r1 in anza-xyz/cryptography (recipe overlay, protected).
// Usage: lineage_bench <scalar_mul|msm|decode> <seed> [--inputs-only]
// Prints a checksum of every result so the work cannot be optimised away. Measured with cachegrind
// instruction counts; inputs depend only on the seed. One thread, no clock, no OS randomness.
// Workloads, after the shapes a secp256r1 syscall or precompile asks for:
//   scalar_mul  VAR_MULS variable-base multiplications, each of a fresh point (the sum of two
//               table points, in Jacobian form) by a fresh scalar, results serialized.
//   msm         DOUBLE_MULS double-scalar multiplications u1*G + u2*Q (the ECDSA verification
//               shape, each with the affine x comparison a verifier makes) and multiscalar
//               multiplications of 8 points, of 32 points and of 1 to 48 points.
//   decode      COMPRESSED compressed encodings of seeded x coordinates in both byte orders (about
//               half are on the curve), UNCOMPRESSED uncompressed ones (valid, off the curve, not
//               canonical, the identity) and ENCODES projective points brought back to bytes.
// Fixed-base multiplication is in no metric: its generator table is built once per process through
// 1.3 MB of array copies, which the C library's memcpy does with code it picks by CPU model (see
// the recipe header). The tests and the equivalence harness cover it.
// Scalars are uniform 256-bit strings; about one in 2^32 is not below the group order and is
// answered with None, which the checksum records.
// --inputs-only draws the same seeded bytes and stops before the first library call: that count is
// everything in a metric that is not the library's work.
#[path = "lineage_support/points.rs"]
mod lineage_points;
#[path = "lineage_support/rng.rs"]
mod lineage_rng;

use lineage_points::POINTS;
use lineage_rng::Rng;
use solana_secp256r1::{
    Endianness,
    field::FieldElement,
    group::{AffinePoint, ProjectivePoint},
};
use std::env;

const VAR_MULS: usize = 400;
const DOUBLE_MULS: usize = 150;
const MSM_8: usize = 12;
const MSM_32: usize = 6;
const MSM_VAR: usize = 4;
const COMPRESSED: usize = 3000;
const UNCOMPRESSED: usize = 3000;
const ENCODES: usize = 400;

struct Acc(u64);

impl Acc {
    fn mix(&mut self, v: u64) {
        self.0 ^= v;
        self.0 = self.0.wrapping_mul(0x100000001b3);
    }
    fn bytes(&mut self, b: &[u8]) {
        for chunk in b.chunks(8) {
            let mut w = [0u8; 8];
            w[..chunk.len()].copy_from_slice(chunk);
            self.mix(u64::from_le_bytes(w));
        }
    }
    fn point(&mut self, p: Option<ProjectivePoint>) {
        match p {
            Some(p) => self.bytes(&p.to_uncompressed(Endianness::Big)),
            None => self.mix(0x6e6f6e65),
        }
    }
}

fn arr<const N: usize>(r: &mut Rng) -> [u8; N] {
    let mut a = [0u8; N];
    for chunk in a.chunks_mut(8) {
        let w = r.next().to_le_bytes();
        chunk.copy_from_slice(&w[..chunk.len()]);
    }
    a
}

/// Two different indexes into the point table.
fn pair(r: &mut Rng) -> (usize, usize) {
    let i = r.below(64) as usize;
    let j = (i + 1 + r.below(63) as usize) % 64;
    (i, j)
}

fn table() -> Vec<AffinePoint> {
    POINTS.iter().map(|b| AffinePoint::from_uncompressed(b, Endianness::Big).expect("table point")).collect()
}

fn run_scalar_mul(r: &mut Rng, acc: &mut Acc, inputs_only: bool) {
    let var: Vec<((usize, usize), [u8; 32])> = (0..VAR_MULS).map(|_| (pair(r), arr::<32>(r))).collect();
    if inputs_only {
        acc.mix(var.len() as u64);
        return;
    }
    let t = table();
    for ((i, j), k) in &var {
        let base = t[*i].to_projective().add_mixed(t[*j]);
        acc.point(base.mul_scalar_vartime(*k));
    }
}

fn run_msm(r: &mut Rng, acc: &mut Acc, inputs_only: bool) {
    let doubles: Vec<(usize, [u8; 32], [u8; 32], [u8; 32])> =
        (0..DOUBLE_MULS).map(|_| (r.below(64) as usize, arr::<32>(r), arr::<32>(r), arr::<32>(r))).collect();
    let mut sizes = vec![8usize; MSM_8];
    sizes.extend(std::iter::repeat_n(32usize, MSM_32));
    for _ in 0..MSM_VAR {
        sizes.push(1 + r.below(48) as usize);
    }
    let batches: Vec<(Vec<usize>, Vec<[u8; 32]>)> = sizes
        .iter()
        .map(|&n| {
            // n different table points: a seeded start and an odd stride walk all 64 before repeating
            let start = r.below(64) as usize;
            let stride = (r.below(32) as usize) * 2 + 1;
            ((0..n).map(|k| (start + k * stride) % 64).collect(), (0..n).map(|_| arr::<32>(r)).collect())
        })
        .collect();
    if inputs_only {
        acc.mix(doubles.len() as u64 + batches.len() as u64);
        return;
    }
    let t = table();
    for (i, u1, u2, x) in &doubles {
        let out = ProjectivePoint::double_scalar_mul_vartime(*u1, t[*i], *u2);
        // what an ECDSA verifier asks of the result: is its affine x this field element
        if let (Some(p), Some(x)) = (out, FieldElement::from_be_bytes(*x)) {
            acc.mix(p.has_affine_x(x) as u64);
        }
        acc.point(out);
    }
    for (idx, scalars) in &batches {
        let points: Vec<AffinePoint> = idx.iter().map(|&i| t[i]).collect();
        acc.point(ProjectivePoint::multi_scalar_mul_vartime(&points, scalars));
    }
}

fn run_decode(r: &mut Rng, acc: &mut Acc, inputs_only: bool) {
    let compressed: Vec<([u8; 33], bool)> = (0..COMPRESSED)
        .map(|_| {
            let mut b = arr::<33>(r);
            b[0] = 2 + (b[0] & 1);
            (b, r.below(2) == 0)
        })
        .collect();
    // kind 0..=4 a table point as it is, 5 one flipped bit, 6 a seeded string, 7 the identity
    let uncompressed: Vec<(usize, u64, [u8; 64], bool)> =
        (0..UNCOMPRESSED).map(|_| (r.below(64) as usize, r.below(8), arr::<64>(r), r.below(2) == 0)).collect();
    let encodes: Vec<((usize, usize), bool)> = (0..ENCODES).map(|_| (pair(r), r.below(2) == 0)).collect();
    if inputs_only {
        acc.mix(compressed.len() as u64 + uncompressed.len() as u64 + encodes.len() as u64);
        return;
    }
    let order = |little: bool| if little { Endianness::Little } else { Endianness::Big };
    for (b, little) in &compressed {
        match AffinePoint::from_compressed(b, order(*little)) {
            Some(p) => acc.bytes(&p.to_uncompressed(Endianness::Big)),
            None => acc.mix(0x6e6f6e65),
        }
    }
    for (i, kind, noise, little) in &uncompressed {
        let mut b = POINTS[*i];
        match kind {
            5 => b[(noise[0] & 63) as usize] ^= 1 << (noise[1] & 7),
            6 => b = *noise,
            7 => b = [0u8; 64],
            _ => {}
        }
        if *little {
            b[..32].reverse();
            b[32..].reverse();
        }
        match AffinePoint::from_uncompressed(&b, order(*little)) {
            Some(p) => {
                acc.mix(p.is_identity() as u64);
                if let Some(c) = p.to_compressed(order(!*little)) {
                    acc.bytes(&c);
                }
            }
            None => acc.mix(0x6e6f6e65),
        }
    }
    let t = table();
    for ((i, j), little) in &encodes {
        // a Jacobian point with z != 1: bringing it back to bytes costs a field inversion
        let p = t[*i].to_projective().add_mixed(t[*j]);
        acc.bytes(&p.to_uncompressed(order(*little)));
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("scalar_mul");
    let seed = args.get(2).cloned().unwrap_or_default();
    let inputs_only = args.iter().any(|a| a == "--inputs-only");
    let mut r = Rng::from_seed_str(&seed);
    let mut acc = Acc(0xcbf29ce484222325);
    match mode {
        "scalar_mul" => run_scalar_mul(&mut r, &mut acc, inputs_only),
        "msm" => run_msm(&mut r, &mut acc, inputs_only),
        "decode" => run_decode(&mut r, &mut acc, inputs_only),
        m => panic!("unknown mode {}", m),
    }
    println!("{} {:016x}", mode, acc.0);
}
