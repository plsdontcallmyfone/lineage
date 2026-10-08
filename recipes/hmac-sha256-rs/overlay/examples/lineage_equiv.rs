// Lineage equivalence harness for jedisct1/rust-hmac-sha256 (recipe overlay, protected).
// Usage: lineage_equiv <seed>
// Prints every public result on seeded inputs: SHA-256 one-shot and streamed with seeded chunking
// (lengths around every block and padding boundary), verify results for good and corrupted
// digests and wrong-length references, HMAC-SHA256 one-shot and incremental for keys of every
// size class, HMAC verify, HKDF extract and expand for every output length class.
#[path = "lineage_support/rng.rs"]
mod lineage_rng;

use hmac_sha256::{Hash, HKDF, HMAC};
use std::env;

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

fn main() {
    let seed = env::args().nth(1).expect("usage: lineage_equiv <seed>");
    let mut r = lineage_rng::Rng::from_seed_str(&seed);
    for i in 0..400usize {
        let n = if i < 200 { i } else { r.below(3000) as usize };
        let m = r.bytes(n);
        let d = Hash::hash(&m);
        let mut h = Hash::new();
        let mut rest = &m[..];
        while !rest.is_empty() {
            let take = core::cmp::min(rest.len(), r.below(130) as usize);
            h.update(&rest[..take]);
            rest = &rest[take..];
        }
        h.update(&[]);
        let d2 = h.finalize();
        let mut bad = d;
        bad[r.below(32) as usize] ^= 1 << r.below(8);
        // references shorter than, equal to and longer than a digest (the digest plus extra bytes)
        let refl = r.below(40) as usize;
        let mut reference = d[..core::cmp::min(refl, 32)].to_vec();
        if refl > 32 {
            let extra = r.bytes(refl - 32);
            reference.extend_from_slice(&extra);
        }
        let mut h3 = Hash::default();
        h3.update(&m);
        let v_ref = h3.verify_with_ref(&reference);
        println!("hash {} {} {} {} {} {}", n, hex(&d), hex(&d2), Hash::verify(&m, &d), Hash::verify(&m, &bad), v_ref);
    }
    for i in 0..300usize {
        let kl = [0usize, 1, 31, 32, 33, 63, 64, 65, 127, 128, 129, 200][i % 12];
        let kn = if i < 120 { kl } else { r.below(300) as usize };
        let key = r.bytes(kn);
        let m = { let n = r.below(400) as usize; r.bytes(n) };
        let a = HMAC::mac(&m, &key);
        let mut s = HMAC::new(&key);
        let cut = r.below(m.len() as u64 + 1) as usize;
        s.update(&m[..cut]);
        s.update(&m[cut..]);
        let s2 = s.clone();
        let b = s.finalize();
        let mut bad = a;
        bad[r.below(32) as usize] ^= 1;
        println!("hmac {} {} {} {} {} {} {}", key.len(), m.len(), hex(&a), hex(&b), s2.finalize_verify(&a), HMAC::verify(&m, &key, &a), HMAC::verify(&m, &key, &bad));
    }
    for i in 0..120usize {
        let salt = { let n = r.below(150) as usize; r.bytes(n) };
        let ikm = { let n = r.below(100) as usize; r.bytes(n) };
        let info = { let n = r.below(120) as usize; r.bytes(n) };
        let prk = HKDF::extract(&salt, &ikm);
        let l = if i < 70 { i * 3 } else { r.below(8159) as usize + 1 };
        let mut okm = vec![0u8; l];
        HKDF::expand(&mut okm, prk, &info);
        let mut okm2 = vec![0u8; l];
        HKDF::expand(&mut okm2, &prk[..], &info[..]);
        println!("hkdf {} {} {} {} {} {}", salt.len(), ikm.len(), info.len(), hex(&prk), hex(&okm), okm == okm2);
    }
}
