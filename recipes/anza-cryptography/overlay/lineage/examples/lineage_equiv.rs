// Lineage equivalence harness for solana-secp256r1 in anza-xyz/cryptography (recipe overlay, protected).
// Usage: lineage_equiv <seed> [--full]
// This is curve arithmetic other code trusts: a patch may make it cheaper and may not change one
// answer. The harness calls every public operation of the crate on seeded inputs and prints every
// answer as canonical bytes (never the internal Montgomery or Jacobian form, which a patch may
// change), so any difference in what the library returns changes the output:
//   field     FIELD_ROUNDS pairs of 32-byte strings through from_be_bytes, +, -, *, negation,
//             square, invert, is_zero, to_be_bytes, from_u64
//   scalar    SCALAR_ROUNDS pairs through from_bytes, from_bytes_reduced and is_canonical in both
//             byte orders, and the same arithmetic modulo the group order
//   encoding  ENCODING_ROUNDS encoded points through from_compressed, from_uncompressed and
//             AffinePoint::new, and back through to_compressed, to_uncompressed, x, y, negation
//   group     GROUP_ROUNDS pairs of points through +, -, add_mixed, double, negation, ==,
//             has_affine_x, to_affine, from_affine, is_identity
//   mul       MUL_ROUNDS rounds of variable-base, fixed-base and double-scalar multiplication,
//             checked and unchecked, and multiscalar multiplications of 0 to 9 points
// A quarter or more of all inputs are edge cases, drawn by seed among: zero, one, two, the modulus
// minus one, the modulus itself and the modulus plus one (not canonical: must be refused, or
// reduced where the API says so), 2^255, 2^256 - 1, values with runs of zero bytes; the identity
// in both of its forms, a point and its negation (the sum is the identity), the same point twice
// (addition must take the doubling path), one point in two Jacobian scalings, coordinates off the
// curve, coordinates not below the field prime, wrong compressed prefixes, multiscalar inputs of
// different lengths, none at all, repeated points, cancelling pairs.
// P-256 has cofactor 1: there are no low-order points to test, the identity is the only one.
// The text is a few megabytes, so the harness digests it itself and prints one line per section:
// the number of lines and a digest of all of them. --full prints the text (to compare two builds).
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
    scalar::Scalar,
};
use std::env;
use std::io::{BufWriter, Write};

const FIELD_ROUNDS: usize = 6000;
const SCALAR_ROUNDS: usize = 6000;
const ENCODING_ROUNDS: usize = 3000;
const GROUP_ROUNDS: usize = 4000;
const MUL_ROUNDS: usize = 500;

const P: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
];
const N: [u8; 32] = [
    0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xbc, 0xe6, 0xfa,
    0xad, 0xa7, 0x17, 0x9e, 0x84, 0xf3, 0xb9, 0xca, 0xc2, 0xfc, 0x63, 0x25, 0x51,
];

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
        if let Some(out) = self.full.as_mut() {
            out.flush().unwrap();
        }
        println!("{} {} {:016x}{:016x}", name, self.count, self.d.0, self.d.1);
        self.d = Digest::new();
        self.count = 0;
    }
}

fn hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push_str(&format!("{:02x}", x));
    }
    s
}

fn opt<T>(v: Option<T>, f: impl Fn(T) -> String) -> String {
    match v {
        Some(v) => f(v),
        None => "none".to_string(),
    }
}

fn fe(v: FieldElement) -> String {
    hex(&v.to_be_bytes())
}

fn sc(v: Scalar) -> String {
    hex(&v.to_be_bytes())
}

/// An affine point as every public reading of it.
fn af(p: AffinePoint) -> String {
    format!(
        "{} {} {} {} {} {} {}",
        p.is_identity() as u8,
        hex(&p.to_uncompressed(Endianness::Big)),
        hex(&p.to_uncompressed(Endianness::Little)),
        opt(p.to_compressed(Endianness::Big), |c| hex(&c)),
        opt(p.to_compressed(Endianness::Little), |c| hex(&c)),
        opt(p.x(), fe),
        opt(p.y(), fe),
    )
}

fn pr(p: ProjectivePoint) -> String {
    format!("{} {}", p.is_identity() as u8, hex(&p.to_uncompressed(Endianness::Big)))
}

fn arr<const L: usize>(r: &mut Rng) -> [u8; L] {
    let mut a = [0u8; L];
    for chunk in a.chunks_mut(8) {
        let w = r.next().to_le_bytes();
        chunk.copy_from_slice(&w[..chunk.len()]);
    }
    a
}

/// `m` plus a small signed offset, as a 256-bit big-endian string (wrapping).
fn near(m: &[u8; 32], delta: i64) -> [u8; 32] {
    let mut out = *m;
    let mut carry = delta.unsigned_abs();
    for b in out.iter_mut().rev() {
        if carry == 0 {
            break;
        }
        if delta >= 0 {
            let s = *b as u64 + (carry & 0xff);
            *b = s as u8;
            carry = (carry >> 8) + (s >> 8);
        } else {
            let (d, borrow) = (*b as u64).overflowing_sub(carry & 0xff);
            *b = d as u8;
            carry = (carry >> 8) + borrow as u64;
        }
    }
    out
}

/// A 32-byte big-endian string for a value modulo `m`: an edge case more than one time in three.
fn value(r: &mut Rng, m: &[u8; 32]) -> [u8; 32] {
    let mut small = [0u8; 32];
    match r.below(36) {
        0 => small,
        1 => {
            small[31] = 1;
            small
        }
        2 => {
            small[31] = 2;
            small
        }
        3 => near(m, -1),
        4 => *m,
        5 => near(m, 1),
        6 => near(m, -(1 + r.below(1000) as i64)),
        7 => near(m, 1 + r.below(1000) as i64),
        8 => [0xff; 32],
        9 => {
            small[0] = 0x80;
            small
        }
        // a small number: only the low bytes set
        10 => {
            small[24..].copy_from_slice(&r.next().to_be_bytes());
            small
        }
        // a seeded string with a run of zero bytes somewhere, the ends included
        11 | 12 => {
            let mut a = arr::<32>(r);
            let start = r.below(32) as usize;
            let len = 1 + r.below(12) as usize;
            for b in a.iter_mut().skip(start).take(len) {
                *b = 0;
            }
            a
        }
        // only the top bytes set
        13 => {
            small[..8].copy_from_slice(&r.next().to_be_bytes());
            small
        }
        _ => arr::<32>(r),
    }
}

fn order(r: &mut Rng) -> Endianness {
    if r.below(2) == 0 { Endianness::Big } else { Endianness::Little }
}

fn swap(mut b: [u8; 32]) -> [u8; 32] {
    b.reverse();
    b
}

fn table() -> Vec<AffinePoint> {
    POINTS.iter().map(|b| AffinePoint::from_uncompressed(b, Endianness::Big).expect("table point")).collect()
}

fn field(r: &mut Rng, out: &mut Lines) {
    for _ in 0..FIELD_ROUNDS {
        let (ab, bb) = (value(r, &P), value(r, &P));
        let (a, b) = (FieldElement::from_be_bytes(ab), FieldElement::from_be_bytes(bb));
        out.line(&format!("f in {} {} {} {}", hex(&ab), hex(&bb), opt(a, fe), opt(b, fe)));
        if let Some(a) = a {
            out.line(&format!(
                "f one {} {} {} {} {}",
                fe(-a),
                fe(a.square()),
                opt(a.invert(), fe),
                a.is_zero() as u8,
                opt(a.invert(), |i| fe(i * a)),
            ));
            if let Some(b) = b {
                out.line(&format!(
                    "f two {} {} {} {} {} {}",
                    fe(a + b),
                    fe(a - b),
                    fe(b - a),
                    fe(a * b),
                    (a == b) as u8,
                    fe(a * b + a - b.square()),
                ));
            }
        }
        let w = r.next() >> (r.below(64) as u32);
        out.line(&format!("f u64 {}", fe(FieldElement::from_u64(w))));
    }
    out.line(&format!("f const {} {}", fe(FieldElement::ZERO), fe(FieldElement::ONE)));
}

fn scalar(r: &mut Rng, out: &mut Lines) {
    for _ in 0..SCALAR_ROUNDS {
        let (ab, bb) = (value(r, &N), value(r, &N));
        let e = order(r);
        let other = if e == Endianness::Little { Endianness::Big } else { Endianness::Little };
        // the same number in the byte order the call is told
        let (ae, be) = if e == Endianness::Little { (swap(ab), swap(bb)) } else { (ab, bb) };
        let (a, b) = (Scalar::from_bytes(&ae, e), Scalar::from_bytes(&be, e));
        let (ar, br) = (Scalar::from_bytes_reduced(&ae, e), Scalar::from_bytes_reduced(&be, e));
        out.line(&format!(
            "s in {} {} {} {} {} {} {} {} {}",
            hex(&ae),
            hex(&be),
            (e == Endianness::Little) as u8,
            opt(a, sc),
            opt(b, sc),
            sc(ar),
            sc(br),
            Scalar::is_canonical(&ae, e) as u8,
            Scalar::is_canonical(&ae, other) as u8,
        ));
        out.line(&format!(
            "s one {} {} {} {} {}",
            sc(-ar),
            sc(ar.square()),
            opt(ar.invert(), sc),
            ar.is_zero() as u8,
            opt(ar.invert(), |i| sc(i * ar)),
        ));
        out.line(&format!(
            "s two {} {} {} {} {} {}",
            sc(ar + br),
            sc(ar - br),
            sc(br - ar),
            sc(ar * br),
            (ar == br) as u8,
            sc(ar * br + ar - br.square()),
        ));
    }
    out.line(&format!("s const {} {}", sc(Scalar::ZERO), sc(Scalar::ONE)));
}

fn encoding(r: &mut Rng, out: &mut Lines) {
    for _ in 0..ENCODING_ROUNDS {
        // compressed: a prefix and an x coordinate
        let e = order(r);
        let i = r.below(64) as usize;
        let mut x = [0u8; 32];
        x.copy_from_slice(&POINTS[i][..32]);
        let x = match r.below(8) {
            0..=2 => x,
            3 => value(r, &P),
            _ => arr::<32>(r),
        };
        let prefix = match r.below(12) {
            0 => 0x00,
            1 => 0x01,
            2 => 0x04,
            3 => r.next() as u8,
            k => 0x02 + (k & 1) as u8,
        };
        let mut c = [0u8; 33];
        c[0] = prefix;
        c[1..].copy_from_slice(&if e == Endianness::Little { swap(x) } else { x });
        out.line(&format!(
            "e comp {} {} {}",
            hex(&c),
            (e == Endianness::Little) as u8,
            opt(AffinePoint::from_compressed(&c, e), af)
        ));

        // uncompressed: X || Y
        let e = order(r);
        let mut u = POINTS[r.below(64) as usize];
        match r.below(12) {
            0 => u = [0u8; 64],
            1 => u[r.below(64) as usize] ^= 1 << r.below(8),
            2 => u = arr::<64>(r),
            // the negation: y becomes p - y, still on the curve
            3 => {
                let p = AffinePoint::from_uncompressed(&u, Endianness::Big).expect("table point");
                u = (-p).to_uncompressed(Endianness::Big);
            }
            4 => {
                let v = value(r, &P);
                u[..32].copy_from_slice(&v);
            }
            5 => {
                let v = value(r, &P);
                u[32..].copy_from_slice(&v);
            }
            // x and y swapped
            6 => u.rotate_left(32),
            // all zero but one bit: not the identity encoding
            7 => {
                u = [0u8; 64];
                u[r.below(64) as usize] = 1 << r.below(8);
            }
            _ => {}
        }
        let mut ue = u;
        if e == Endianness::Little {
            ue[..32].reverse();
            ue[32..].reverse();
        }
        let p = AffinePoint::from_uncompressed(&ue, e);
        out.line(&format!("e unc {} {} {}", hex(&ue), (e == Endianness::Little) as u8, opt(p, af)));
        if let Some(p) = p {
            out.line(&format!("e neg {} {}", af(-p), pr(p.to_projective())));
        }

        // from two field elements
        let mut xb = [0u8; 32];
        let mut yb = [0u8; 32];
        xb.copy_from_slice(&u[..32]);
        yb.copy_from_slice(&u[32..]);
        if let (Some(x), Some(y)) = (FieldElement::from_be_bytes(xb), FieldElement::from_be_bytes(yb)) {
            out.line(&format!(
                "e new {} {} {}",
                opt(AffinePoint::new(x, y), af),
                opt(AffinePoint::new(y, x), af),
                opt(AffinePoint::new(x, -y), af)
            ));
        }
    }
    out.line(&format!(
        "e const {} | {} | {} | {}",
        af(AffinePoint::IDENTITY),
        af(AffinePoint::identity()),
        af(AffinePoint::GENERATOR),
        af(AffinePoint::generator())
    ));
}

/// A point for the group and multiplication sections, in Jacobian form: a table point, a sum of
/// two (z != 1), a doubling, the identity (as the constant, and as P - P computed).
fn point(r: &mut Rng, t: &[AffinePoint]) -> ProjectivePoint {
    let a = t[r.below(64) as usize];
    let b = t[r.below(64) as usize];
    match r.below(10) {
        0 => ProjectivePoint::IDENTITY,
        1 => a.to_projective() + (-a).to_projective(),
        2 => a.to_projective().double(),
        3..=5 => a.to_projective().add_mixed(b),
        6 => ProjectivePoint::GENERATOR,
        _ => a.to_projective(),
    }
}

fn group(r: &mut Rng, out: &mut Lines, t: &[AffinePoint]) {
    for _ in 0..GROUP_ROUNDS {
        let p = point(r, t);
        let q = match r.below(8) {
            // the same point: the sum must take the doubling path
            0 => p,
            // its negation: the sum is the identity
            1 => -p,
            // the same point in another Jacobian scaling
            2 => (p + ProjectivePoint::GENERATOR) - ProjectivePoint::GENERATOR,
            // its negation in another scaling
            3 => -((p + ProjectivePoint::GENERATOR) - ProjectivePoint::GENERATOR),
            _ => point(r, t),
        };
        let qa = q.to_affine();
        out.line(&format!("g in {} | {} | {}", pr(p), pr(q), af(qa)));
        out.line(&format!(
            "g ops {} | {} | {} | {} | {} | {} | {} | {}",
            pr(p + q),
            pr(q + p),
            pr(p - q),
            pr(p.add_mixed(qa)),
            pr(p.add_mixed(-qa)),
            pr(p.double()),
            pr(-p),
            pr((p + q).double() - q),
        ));
        let xs = [qa.x(), p.to_affine().x(), FieldElement::from_be_bytes(value(r, &P))];
        let has: Vec<String> =
            xs.iter().map(|x| opt(*x, |x| format!("{}{}", p.has_affine_x(x) as u8, q.has_affine_x(x) as u8))).collect();
        out.line(&format!(
            "g cmp {} {} {} {} {} {} {} {} {}",
            (p == q) as u8,
            (q == p) as u8,
            (p == p.double()) as u8,
            (p + q == q + p) as u8,
            (ProjectivePoint::from_affine(qa) == q) as u8,
            (qa.to_projective() == p) as u8,
            has.join(","),
            p.is_identity() as u8,
            hex(&q.to_uncompressed(Endianness::Little)),
        ));
    }
    out.line(&format!(
        "g const {} | {} | {} | {}",
        pr(ProjectivePoint::IDENTITY),
        pr(ProjectivePoint::identity()),
        pr(ProjectivePoint::GENERATOR),
        pr(ProjectivePoint::generator())
    ));
}

fn mul(r: &mut Rng, out: &mut Lines, t: &[AffinePoint]) {
    let o = |v: Option<ProjectivePoint>| opt(v, pr);
    for _ in 0..MUL_ROUNDS {
        let p = point(r, t);
        let pa = p.to_affine();
        let (k, l) = (value(r, &N), value(r, &N));
        out.line(&format!("m in {} | {} {}", pr(p), hex(&k), hex(&l)));
        out.line(&format!("m var {} | {}", o(p.mul_scalar_vartime(k)), pr(p.mul_scalar_vartime_unchecked(k))));
        out.line(&format!(
            "m fix {} | {}",
            o(ProjectivePoint::fixed_base_scalar_mul_vartime(k)),
            pr(ProjectivePoint::fixed_base_scalar_mul_vartime_unchecked(k))
        ));
        out.line(&format!(
            "m dbl {} | {}",
            o(ProjectivePoint::double_scalar_mul_vartime(k, pa, l)),
            pr(ProjectivePoint::double_scalar_mul_vartime_unchecked(k, pa, l))
        ));

        // multiscalar: 0 to 9 points, with repeats, identities and cancelling pairs
        let n = r.below(10) as usize;
        let mut points: Vec<AffinePoint> = Vec::new();
        let mut scalars: Vec<[u8; 32]> = Vec::new();
        for _ in 0..n {
            let s = value(r, &N);
            match r.below(8) {
                // the negation of the previous point with the previous scalar: the pair cancels
                0 if !points.is_empty() => {
                    let last = points[points.len() - 1];
                    let ls = scalars[scalars.len() - 1];
                    points.push(-last);
                    scalars.push(ls);
                }
                1 if !points.is_empty() => {
                    points.push(points[0]);
                    scalars.push(s);
                }
                2 => {
                    points.push(AffinePoint::IDENTITY);
                    scalars.push(s);
                }
                _ => {
                    points.push(point(r, t).to_affine());
                    scalars.push(s);
                }
            }
        }
        out.line(&format!(
            "m msm {} {} | {}",
            n,
            o(ProjectivePoint::multi_scalar_mul_vartime(&points, &scalars)),
            o(ProjectivePoint::multi_scalar_mul_vartime_unchecked(&points, &scalars))
        ));
        // different lengths: every form must refuse
        if n > 0 && r.below(4) == 0 {
            out.line(&format!(
                "m len {} {} {}",
                o(ProjectivePoint::multi_scalar_mul_vartime(&points[1..], &scalars)),
                o(ProjectivePoint::multi_scalar_mul_vartime_unchecked(&points, &scalars[1..])),
                o(ProjectivePoint::multi_scalar_mul_vartime(&points, &[])),
            ));
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();
    let seed = args.get(1).cloned().unwrap_or_default();
    let full = args.iter().any(|a| a == "--full");
    let mut r = Rng::from_seed_str(&seed);
    let mut out = Lines { d: Digest::new(), count: 0, full: full.then(|| BufWriter::new(std::io::stdout())) };
    field(&mut r, &mut out);
    out.section("field");
    scalar(&mut r, &mut out);
    out.section("scalar");
    encoding(&mut r, &mut out);
    out.section("encoding");
    let t = table();
    group(&mut r, &mut out, &t);
    out.section("group");
    mul(&mut r, &mut out, &t);
    out.section("mul");
}
