// Lineage equivalence harness (recipe overlay, protected). Usage: lineage_equiv <seed hex>
// Prints encode and decode outputs for seeded random inputs, including long inputs and leading
// zeros the unit tests do not cover. Base and candidate must print identical bytes.
use std::env;

fn main() {
    let arg = env::args().nth(1).unwrap_or_else(|| "1".into());
    let mut x = u64::from_str_radix(&arg[..16.min(arg.len())], 16).unwrap_or(1) | 1;
    let mut next = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    for _ in 0..300 {
        let len = (next() % 300) as usize;
        let lead = (next() % 5) as usize;
        let mut v = vec![0u8; lead];
        v.extend((0..len).map(|_| next() as u8));
        let e = fixture_b58::encode(&v);
        println!("{e}");
        println!("{:?}", fixture_b58::decode(&e).map(|d| d == v));
    }
    for s in ["", "1", "111z", "0", "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"] {
        println!("{:?}", fixture_b58::decode(s));
    }
}
