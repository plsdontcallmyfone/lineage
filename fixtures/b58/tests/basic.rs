use fixture_b58::{decode, encode, DecodeError};

#[test]
fn encode_known_vectors() {
    assert_eq!(encode(b""), "");
    assert_eq!(encode(b"hello world"), "StV1DL6CwTryKyV");
    assert_eq!(encode(&[0, 0, 1]), "112");
    assert_eq!(encode(&[255; 4]), "7YXq9G");
}

#[test]
fn decode_known_vectors() {
    assert_eq!(decode("StV1DL6CwTryKyV").unwrap(), b"hello world");
    assert_eq!(decode("7YXq9G").unwrap(), vec![255; 4]);
}

#[test]
fn decode_rejects_invalid() {
    assert_eq!(decode("0abc"), Err(DecodeError::InvalidCharacter { character: '0', index: 0 }));
    assert_eq!(decode("abIl"), Err(DecodeError::InvalidCharacter { character: 'I', index: 2 }));
}

#[test]
fn roundtrip_short_inputs() {
    let mut x: u32 = 7;
    for len in 1..48 {
        let v: Vec<u8> = (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (x >> 3) as u8 | 1
            })
            .collect();
        assert_eq!(decode(&encode(&v)).unwrap(), v);
    }
}

#[test]
fn decode_leading_ones_are_zero_bytes() {
    assert_eq!(decode("112").unwrap(), vec![0, 0, 1]);
    assert_eq!(decode("1").unwrap(), vec![0]);
}
