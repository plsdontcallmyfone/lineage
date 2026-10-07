use cu_tally::{crc32, digest, record, sort, Stats, STATE_LEN};

fn le64(vals: &[u64]) -> Vec<u8> {
    vals.iter().flat_map(|v| v.to_le_bytes()).collect()
}

fn le32(vals: &[u32]) -> Vec<u8> {
    vals.iter().flat_map(|v| v.to_le_bytes()).collect()
}

#[test]
fn record_tracks_count_sum_max_min() {
    let mut st = vec![0u8; STATE_LEN];
    record(&mut st, &le64(&[5, 3, 9])).unwrap();
    assert_eq!(Stats::load(&st), Stats { count: 3, sum: 17, max: 9, min: 3 });
    record(&mut st, &le64(&[1, 20])).unwrap();
    assert_eq!(Stats::load(&st), Stats { count: 5, sum: 38, max: 20, min: 1 });
}

#[test]
fn record_empty_is_noop() {
    let mut st = vec![0u8; STATE_LEN];
    record(&mut st, &[]).unwrap();
    assert_eq!(Stats::load(&st), Stats { count: 0, sum: 0, max: 0, min: 0 });
}

#[test]
fn record_sum_wraps() {
    let mut st = vec![0u8; STATE_LEN];
    record(&mut st, &le64(&[u64::MAX, 2])).unwrap();
    assert_eq!(Stats::load(&st).sum, 1);
    assert_eq!(Stats::load(&st).min, 2);
}

#[test]
fn record_rejects_ragged_input() {
    let mut st = vec![0u8; STATE_LEN];
    assert!(record(&mut st, &[1, 2, 3]).is_err());
    assert!(record(&mut vec![0u8; 8], &le64(&[1])).is_err());
}

#[test]
fn crc32_known_vectors() {
    assert_eq!(crc32(b""), 0);
    assert_eq!(crc32(b"123456789"), 0xCBF4_3926);
    assert_eq!(crc32(b"The quick brown fox jumps over the lazy dog"), 0x414F_A339);
}

#[test]
fn digest_stores_crc() {
    let mut st = vec![0u8; STATE_LEN];
    assert_eq!(digest(&mut st, b"abc").unwrap(), 0x3524_41C2);
    assert_eq!(&st[32..36], &0x3524_41C2u32.to_le_bytes());
}

#[test]
fn sort_orders_and_returns_median() {
    let mut st = vec![0u8; STATE_LEN];
    let m = sort(&mut st, &le32(&[9, 1, 7, 3, 3])).unwrap();
    assert_eq!(m, 3);
    assert_eq!(&st[40..44], &5u32.to_le_bytes());
    assert_eq!(&st[64..84], &le32(&[1, 3, 3, 7, 9])[..]);
}

#[test]
fn sort_even_count_takes_lower_middle() {
    let mut st = vec![0u8; STATE_LEN];
    assert_eq!(sort(&mut st, &le32(&[4, 2, 8, 6])).unwrap(), 4);
}

#[test]
fn sort_rejects_bad_input() {
    let mut st = vec![0u8; STATE_LEN];
    assert!(sort(&mut st, &[]).is_err());
    assert!(sort(&mut st, &[1, 2]).is_err());
    assert!(sort(&mut st, &le32(&[0; 65])).is_err());
}
