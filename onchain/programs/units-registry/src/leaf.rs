//! The Merkle hashing of `packages/protocol` (econ.ts, hash.ts), byte for byte, so a root built
//! by Core verifies here without a second encoding:
//!
//! - `H(...parts)` = sha256(canonical JSON array of the parts), strings as JSON strings, integers
//!   in decimal.
//! - `leafHash(data)` = `H("leaf", data)`, where `data` is itself canonical JSON of an object
//!   (sorted keys, no whitespace), so it appears JSON-escaped inside the outer array.
//! - `nodeHash(a, b)` = `H("node", min, max)` over the lowercase hex of the two children, sorted as
//!   strings (equal to sorting the bytes), so proofs carry no left/right flags.
//!
//! Only the shapes the programs need are encoded: objects whose values are strings made of
//! characters that need no JSON escape (base58, decimal digits, `:`) or unsigned integers. A
//! string with any other character is refused rather than encoded differently from JavaScript.
use anchor_lang::solana_program::hash::hashv;

pub type Hash = [u8; 32];

pub enum Val<'a> {
    /// A JSON string; only bytes accepted by `safe_str`.
    Str(&'a [u8]),
    /// A JSON number (JavaScript prints integers below 2^53 in plain decimal).
    Num(u64),
}

/// Bytes that `JSON.stringify` copies unchanged and that need no escape when the whole object is
/// itself embedded as a JSON string: printable ASCII except `"` and `\`.
pub fn safe_str(s: &[u8]) -> bool {
    s.iter().all(|b| (0x20..0x7f).contains(b) && *b != b'"' && *b != b'\\')
}

pub fn decimal(mut n: u64, out: &mut Vec<u8>) {
    let mut buf = [0u8; 20];
    let mut i = buf.len();
    loop {
        i -= 1;
        buf[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    out.extend_from_slice(&buf[i..]);
}

/// `canonicalJson(obj)` for `fields` given in sorted key order. None if a key or string value is
/// not `safe_str`, or the keys are not strictly sorted.
pub fn canonical_object(fields: &[(&str, Val)]) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(160);
    out.push(b'{');
    let mut prev: Option<&str> = None;
    for (i, (k, v)) in fields.iter().enumerate() {
        if let Some(p) = prev {
            // JavaScript sorts keys by UTF-16 code units; for ASCII keys that is byte order.
            if p.as_bytes() >= k.as_bytes() {
                return None;
            }
        }
        prev = Some(k);
        if !safe_str(k.as_bytes()) {
            return None;
        }
        if i > 0 {
            out.push(b',');
        }
        out.push(b'"');
        out.extend_from_slice(k.as_bytes());
        out.extend_from_slice(b"\":");
        match v {
            Val::Str(s) => {
                if !safe_str(s) {
                    return None;
                }
                out.push(b'"');
                out.extend_from_slice(s);
                out.push(b'"');
            }
            Val::Num(n) => decimal(*n, &mut out),
        }
    }
    out.push(b'}');
    Some(out)
}

/// JSON string escape as `JSON.stringify` writes it, for the characters that can occur here:
/// `"` and `\` escaped, control characters as `\b \f \n \r \t` or `\u00xx`, everything else
/// (including UTF-8 above ASCII) copied.
pub fn json_string(s: &[u8], out: &mut Vec<u8>) {
    out.push(b'"');
    for &b in s {
        match b {
            b'"' => out.extend_from_slice(b"\\\""),
            b'\\' => out.extend_from_slice(b"\\\\"),
            0x08 => out.extend_from_slice(b"\\b"),
            0x0c => out.extend_from_slice(b"\\f"),
            b'\n' => out.extend_from_slice(b"\\n"),
            b'\r' => out.extend_from_slice(b"\\r"),
            b'\t' => out.extend_from_slice(b"\\t"),
            0x00..=0x1f => {
                const HEX: &[u8; 16] = b"0123456789abcdef";
                out.extend_from_slice(b"\\u00");
                out.push(HEX[(b >> 4) as usize]);
                out.push(HEX[(b & 15) as usize]);
            }
            _ => out.push(b),
        }
    }
    out.push(b'"');
}

/// `H(tag, s)` for one string part: sha256 of `["<tag>",<json string of s>]`.
pub fn h_tag_str(tag: &str, s: &[u8]) -> Hash {
    let mut out = Vec::with_capacity(s.len() + s.len() / 4 + tag.len() + 8);
    out.extend_from_slice(b"[\"");
    out.extend_from_slice(tag.as_bytes());
    out.extend_from_slice(b"\",");
    json_string(s, &mut out);
    out.push(b']');
    hashv(&[&out]).to_bytes()
}

/// `leafHash(data)`.
pub fn leaf_hash(data: &[u8]) -> Hash {
    h_tag_str("leaf", data)
}

fn hex(h: &Hash) -> [u8; 64] {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = [0u8; 64];
    for (i, b) in h.iter().enumerate() {
        out[2 * i] = HEX[(b >> 4) as usize];
        out[2 * i + 1] = HEX[(b & 15) as usize];
    }
    out
}

/// `nodeHash(a, b)`: `H("node", lo, hi)` over the hex strings.
pub fn node_hash(a: &Hash, b: &Hash) -> Hash {
    let (lo, hi) = if a < b { (a, b) } else { (b, a) };
    hashv(&[b"[\"node\",\"", &hex(lo), b"\",\"", &hex(hi), b"\"]"]).to_bytes()
}

/// `verifyProof(leaf, proof, root)`.
pub fn verify_proof(leaf: &Hash, proof: &[Hash], root: &Hash) -> bool {
    let mut acc = *leaf;
    for p in proof {
        acc = node_hash(&acc, p);
    }
    acc == *root
}

/// Base58 (Bitcoin alphabet) of 32 bytes, as `base58Encode` in protocol/auth.ts writes a key.
pub fn base58_32(bytes: &[u8; 32]) -> ([u8; 44], usize) {
    const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let mut digits = [0u8; 44];
    let mut len = 0usize;
    for &b in bytes.iter() {
        let mut carry = b as u32;
        for d in digits[..len].iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits[len] = (carry % 58) as u8;
            len += 1;
            carry /= 58;
        }
    }
    let zeros = bytes.iter().take_while(|b| **b == 0).count();
    let mut out = [0u8; 44];
    let mut n = 0;
    for _ in 0..zeros {
        out[n] = b'1';
        n += 1;
    }
    for i in (0..len).rev() {
        out[n] = ALPHABET[digits[i] as usize];
        n += 1;
    }
    (out, n)
}

/// Where a payout leaf pays: Core's ledger account names (packages/core ledger `ACC`).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Dest {
    /// `agent:<id>:wallet`
    AgentWallet,
    /// `agent:<id>:compute`
    AgentCompute,
    /// `wallet:<address>`
    Wallet,
}

pub fn dest_string(kind: Dest, agent_b58: &[u8], wallet: &[u8; 32]) -> Vec<u8> {
    let mut s = Vec::with_capacity(64);
    match kind {
        Dest::AgentWallet | Dest::AgentCompute => {
            s.extend_from_slice(b"agent:");
            s.extend_from_slice(agent_b58);
            s.extend_from_slice(if kind == Dest::AgentWallet { b":wallet" } else { b":compute" });
        }
        Dest::Wallet => {
            let (w, n) = base58_32(wallet);
            s.extend_from_slice(b"wallet:");
            s.extend_from_slice(&w[..n]);
        }
    }
    s
}

/// The payout leaf of protocol/core: `leafHash(canonicalJson({ epoch, agent, dest, amount }))`
/// with `amount` a decimal string and `epoch` a number.
pub fn payout_leaf(epoch: u64, agent: &[u8; 32], kind: Dest, wallet: &[u8; 32], amount: u64) -> Hash {
    let (a, n) = base58_32(agent);
    let dest = dest_string(kind, &a[..n], wallet);
    let mut amt = Vec::with_capacity(20);
    decimal(amount, &mut amt);
    let data = canonical_object(&[
        ("agent", Val::Str(&a[..n])),
        ("amount", Val::Str(&amt)),
        ("dest", Val::Str(&dest)),
        ("epoch", Val::Num(epoch)),
    ])
    .expect("only safe characters");
    leaf_hash(&data)
}

/// The usage leaf the hosted runtime posts per agent and epoch (SPEC 13.7), same hashing:
/// `leafHash(canonicalJson({ agent, amount, epoch, model_tokens, sandbox_s }))` with `amount` a
/// decimal string and the other three numbers.
pub fn usage_leaf(epoch: u64, agent: &[u8; 32], amount: u64, model_tokens: u64, sandbox_s: u64) -> Hash {
    let (a, n) = base58_32(agent);
    let mut amt = Vec::with_capacity(20);
    decimal(amount, &mut amt);
    let data = canonical_object(&[
        ("agent", Val::Str(&a[..n])),
        ("amount", Val::Str(&amt)),
        ("epoch", Val::Num(epoch)),
        ("model_tokens", Val::Num(model_tokens)),
        ("sandbox_s", Val::Num(sandbox_s)),
    ])
    .expect("only safe characters");
    leaf_hash(&data)
}

/// `repoId(url)` = `H("repo", canonicalUrl(url))` for a URL that is already canonical.
pub fn repo_id(url: &[u8]) -> Hash {
    h_tag_str("repo", url)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decimal_and_base58() {
        let mut v = Vec::new();
        decimal(0, &mut v);
        v.push(b' ');
        decimal(18_446_744_073_709_551_615, &mut v);
        assert_eq!(v, b"0 18446744073709551615");
        assert_eq!(&base58_32(&[0u8; 32]).0[..32], &[b'1'; 32]);
        let k = [255u8; 32];
        let (s, n) = base58_32(&k);
        assert_eq!(&s[..n], b"JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxFG");
    }
    #[test]
    fn escape() {
        let mut o = Vec::new();
        json_string(b"a\"b\\c\n\x01", &mut o);
        assert_eq!(o, b"\"a\\\"b\\\\c\\n\\u0001\"");
    }
}
