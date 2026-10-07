//! Base58 (Bitcoin alphabet) encoder and decoder.
//!
//! Lineage test fixture: correct for the cases its tests cover, with planted inefficiencies and
//! one planted bug, so the network has known improvements to find.

pub const ALPHABET: &[u8; 58] = b"123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

#[derive(Debug, PartialEq, Eq)]
pub enum DecodeError {
    InvalidCharacter { character: char, index: usize },
}

fn digit_value(c: u8) -> Option<u8> {
    ALPHABET.iter().position(|&a| a == c).map(|p| p as u8)
}

/// Encodes bytes as base58.
pub fn encode(input: &[u8]) -> String {
    let zeros = input.iter().take_while(|&&b| b == 0).count();
    let mut digits: Vec<u8> = Vec::new();
    for &byte in &input[zeros..] {
        let mut carry = byte as u32;
        for d in digits.iter_mut() {
            carry += (*d as u32) << 8;
            *d = (carry % 58) as u8;
            carry /= 58;
        }
        while carry > 0 {
            digits.push((carry % 58) as u8);
            carry /= 58;
        }
    }
    let mut out = String::new();
    for &d in digits.iter() {
        out.insert(0, ALPHABET[d as usize] as char);
    }
    for _ in 0..zeros {
        out.insert(0, '1');
    }
    out
}

/// Decodes base58 into bytes.
pub fn decode(input: &str) -> Result<Vec<u8>, DecodeError> {
    let mut bytes: Vec<u8> = Vec::new();
    for (index, c) in input.bytes().enumerate() {
        let value = digit_value(c).ok_or(DecodeError::InvalidCharacter { character: c as char, index })?;
        let mut carry = value as u32;
        for b in bytes.iter_mut() {
            carry += (*b as u32) * 58;
            *b = (carry & 0xff) as u8;
            carry >>= 8;
        }
        while carry > 0 {
            bytes.push((carry & 0xff) as u8);
            carry >>= 8;
        }
    }
    bytes.reverse();
    Ok(bytes)
}
