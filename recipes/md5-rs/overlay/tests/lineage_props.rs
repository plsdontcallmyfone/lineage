// Lineage property tests for stainless-steel/md5 (recipe overlay, protected). Expected digests
// were computed with Python's hashlib (an independent implementation) when the recipe was written,
// for messages of every length around the 64-byte block and the 56-byte padding boundary, and are
// checked one-shot, streamed at several split points, and through io::Write. Formatting is checked
// against the digest bytes: lower and upper hex, Debug, and formatter flags (which upstream's
// implementation ignores).
use md5::{compute, Context, Digest};
use std::io::Write;

fn msg(i: usize, n: usize) -> Vec<u8> {
    (0..n).map(|j| ((j * 31 + i * 7 + 13) & 0xff) as u8).collect()
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{:02x}", x)).collect()
}

const DIGESTS: &[(usize, &str)] = &[
    (0, "d41d8cd98f00b204e9800998ecf8427e"),
    (1, "15f41a2e96bae341dde485bb0e78f485"),
    (2, "de69e4932571e712b0f597ff49d70263"),
    (3, "642856d54632b37b7cbad3ed3028816d"),
    (15, "73431911c68160c514e0ac7062fbdec2"),
    (16, "3290f16f6c94da54452d184f200e5a2a"),
    (31, "34079fd3d323e52fde3d261b591536e9"),
    (32, "75ba76bd034558c6442c21e1af375b9d"),
    (54, "c2e3d7be8c3dfd464d2323b5310af3c2"),
    (55, "e15ed53718e1960cf49db0f3b1e17e40"),
    (56, "c10dd8cc059f5b69a76ff549e24b8910"),
    (57, "8e362b2e011a9d9d03f440fe929cfbd1"),
    (63, "6b1dedf08d0fa4b591f021912ea28204"),
    (64, "5800ac43c5b04f428ffed96fd10cfbd8"),
    (65, "ae718e68ea51f365dcf0fecfb1c383bc"),
    (100, "52c8a19584f097207af08fce016aef0d"),
    (119, "0ff50e5cde67cda10193fb98ff6c16b1"),
    (120, "78a3f32007553c5f952746e79fdd0875"),
    (121, "b80913c082b9051560ff8c672c8f4fdb"),
    (127, "481ed3bb95ccd3bcb14a5bda4aad21f9"),
    (128, "2554b0ec11ce2d09858ac944b9401429"),
    (129, "9d6e221f2d61d3bf70f4c89fc6115528"),
    (191, "e936c7562f7f8be7f5faffaf63b61bcc"),
    (192, "84182e8f10015b799bf25a37fecd57df"),
    (255, "55523863098761751adb0cecc2c17ebd"),
    (256, "df92550aae794f23d38d266b121474a5"),
    (1000, "6bdaf159637aa152e154844f233ae079"),
    (4097, "a0137527580d37464725fefa35925f0d"),
];

#[test]
fn one_shot() {
    for (k, &(n, want)) in DIGESTS.iter().enumerate() {
        assert_eq!(hex(&compute(msg(k, n)).0), want, "length {}", n);
    }
}

#[test]
fn streamed_and_written() {
    for (k, &(n, want)) in DIGESTS.iter().enumerate() {
        let m = msg(k, n);
        for split in [1usize, 3, 55, 56, 64, 65, 200] {
            let mut c = Context::new();
            for chunk in m.chunks(split) {
                c.consume(chunk);
            }
            c.consume([]);
            assert_eq!(hex(&c.finalize().0), want, "length {} split {}", n, split);
            let mut w = Context::default();
            for chunk in m.chunks(split) {
                w.write_all(chunk).unwrap();
            }
            w.flush().unwrap();
            assert_eq!(hex(&Digest::from(w).0), want);
        }
    }
}

#[test]
fn formatting() {
    for (k, &(n, want)) in DIGESTS.iter().enumerate() {
        let d = compute(msg(k, n));
        assert_eq!(format!("{:x}", d), want);
        assert_eq!(format!("{:X}", d), want.to_uppercase());
        assert_eq!(format!("{:?}", d), want);
        assert_eq!(format!("{:#x}", d), want);
        assert_eq!(format!("{:>40x}", d), want);
        let bytes: [u8; 16] = d.into();
        assert_eq!(hex(&bytes), want);
        assert_eq!(*d, bytes);
    }
}
