// Lineage harness (recipe overlay, protected). Usage: lineage_bench <encode|decode> <seed hex>
// Prints one number: the checksum of the outputs (so the work cannot be optimised away).
use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();
    let mode = args.get(1).map(String::as_str).unwrap_or("encode");
    let seed = u64::from_str_radix(&args.get(2).cloned().unwrap_or_else(|| "1".into())[..16.min(args.get(2).map_or(1, |s| s.len()))], 16).unwrap_or(1) | 1;
    let mut x = seed;
    let mut next = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    let mut inputs = Vec::new();
    for _ in 0..200 {
        let len = (next() % 120) as usize + 8;
        let lead = (next() % 4) as usize;
        let mut v = vec![0u8; lead];
        v.extend((0..len).map(|_| next() as u8));
        inputs.push(v);
    }
    let mut checksum: u64 = 0;
    match mode {
        "decode" => {
            let encoded: Vec<String> = inputs.iter().map(|v| fixture_b58::encode(v)).collect();
            for _ in 0..5 {
                for s in &encoded {
                    let d = fixture_b58::decode(s).unwrap();
                    checksum = checksum.wrapping_mul(31).wrapping_add(d.len() as u64);
                }
            }
        }
        _ => {
            for _ in 0..5 {
                for v in &inputs {
                    let s = fixture_b58::encode(v);
                    checksum = checksum.wrapping_mul(31).wrapping_add(s.len() as u64);
                }
            }
        }
    }
    println!("{checksum}");
}
