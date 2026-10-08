// Verbatim copy of upstream's unit test (src/lib.rs, `#[test] fn main`) at the recipe snapshot,
// kept under a protected path so the same assertions always run (recipe overlay, protected).
use hmac_sha256::{Hash, HKDF, HMAC};

#[test]
fn upstream_main() {
    let h = HMAC::mac([], [0u8; 32]);
    assert_eq!(
        &h[..],
        &[
            182, 19, 103, 154, 8, 20, 217, 236, 119, 47, 149, 215, 120, 195, 95, 197, 255, 22, 151,
            196, 147, 113, 86, 83, 198, 199, 18, 20, 66, 146, 197, 173
        ]
    );

    let h = HMAC::mac([42u8; 69], []);
    assert_eq!(
        &h[..],
        &[
            225, 88, 35, 8, 78, 185, 165, 6, 235, 124, 28, 250, 112, 124, 159, 119, 159, 88, 184,
            61, 7, 37, 166, 229, 71, 154, 83, 153, 151, 181, 182, 72
        ]
    );

    let h = HMAC::mac([69u8; 250], [42u8; 50]);
    assert_eq!(
        &h[..],
        &[
            112, 156, 120, 216, 86, 25, 79, 210, 155, 193, 32, 120, 116, 134, 237, 14, 198, 1, 64,
            41, 124, 196, 103, 91, 109, 216, 36, 133, 4, 234, 218, 228
        ]
    );

    let mut s = HMAC::new([42u8; 50]);
    s.update([69u8; 150]);
    s.update([69u8; 100]);
    let h = s.finalize();
    assert_eq!(
        &h[..],
        &[
            112, 156, 120, 216, 86, 25, 79, 210, 155, 193, 32, 120, 116, 134, 237, 14, 198, 1, 64,
            41, 124, 196, 103, 91, 109, 216, 36, 133, 4, 234, 218, 228
        ]
    );

    // Test HMAC verify function
    let expected_mac = HMAC::mac([69u8; 250], [42u8; 50]);
    let mut hmac = HMAC::new([42u8; 50]);
    hmac.update([69u8; 250]);
    assert!(hmac.finalize_verify(&expected_mac));

    let mut hmac = HMAC::new([42u8; 50]);
    hmac.update([69u8; 251]); // Different data
    assert!(!hmac.finalize_verify(&expected_mac));

    // Test HMAC one-shot verify function
    assert!(HMAC::verify([69u8; 250], [42u8; 50], &expected_mac));
    assert!(!HMAC::verify([69u8; 251], [42u8; 50], &expected_mac)); // Different data
    assert!(!HMAC::verify([69u8; 250], [43u8; 50], &expected_mac)); // Different key

    // Test Hash verify function
    let expected_hash = Hash::hash(&[42u8; 123]);
    assert!(Hash::verify(&[42u8; 123], &expected_hash));
    assert!(!Hash::verify(&[42u8; 124], &expected_hash));

    // Test Hash finalize_verify function
    let mut hasher = Hash::new();
    hasher.update(&[42u8; 123]);
    assert!(hasher.finalize_verify(&expected_hash));

    let mut hasher = Hash::new();
    hasher.update(&[42u8; 124]); // Different data
    assert!(!hasher.finalize_verify(&expected_hash));

    let ikm = [0x0bu8; 22];
    let salt = [
        0x00u8, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c,
    ];
    let context = [0xf0u8, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9];
    let prk = HKDF::extract(salt, ikm);
    let mut k = [0u8; 40];
    HKDF::expand(&mut k, prk, context);
    assert_eq!(
        &k[..],
        &[
            60, 178, 95, 37, 250, 172, 213, 122, 144, 67, 79, 100, 208, 54, 47, 42, 45, 45, 10,
            144, 207, 26, 90, 76, 93, 176, 45, 86, 236, 196, 197, 191, 52, 0, 114, 8, 213, 184,
            135, 24
        ]
    );
}
