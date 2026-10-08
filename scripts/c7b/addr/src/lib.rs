//! C7b prototype downstream crate: versioned, checksummed base58 addresses over the upstream
//! fixture-b58 encoder. Its own work (version byte and checksum) runs before every upstream call.

/// FNV-1a over the bytes, folded to four bytes.
fn checksum(data: &[u8]) -> [u8; 4] {
    let mut h: u32 = 0x811c9dc5;
    for &b in data {
        h ^= b as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h.to_be_bytes()
}

/// version | payload | checksum(version | payload), base58-encoded by the upstream crate.
pub fn address(version: u8, payload: &[u8]) -> String {
    let mut buf = Vec::with_capacity(payload.len() + 5);
    buf.push(version);
    buf.extend_from_slice(payload);
    let c = checksum(&buf);
    buf.extend_from_slice(&c);
    fixture_b58::encode(&buf)
}
