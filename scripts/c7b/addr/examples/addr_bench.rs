// C7b prototype benchmark. Usage: addr_bench [--print] <seed hex>
// Prints a checksum of the addresses (or every address with --print, for the behaviour digest).
use std::env;

fn main() {
    let args: Vec<String> = env::args().collect();
    let print = args.iter().any(|a| a == "--print");
    let seed_arg = args.iter().skip(1).find(|a| *a != "--print").cloned().unwrap_or_else(|| "1".into());
    let mut x = u64::from_str_radix(&seed_arg[..16.min(seed_arg.len())], 16).unwrap_or(1) | 1;
    let mut next = move || {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        x
    };
    let mut payloads = Vec::new();
    for _ in 0..200 {
        let len = (next() % 40) as usize + 20;
        payloads.push((0..len).map(|_| next() as u8).collect::<Vec<u8>>());
    }
    let mut sum: u64 = 0;
    for round in 0..5u8 {
        for p in &payloads {
            let a = fixture_addr::address(round, p);
            if print && round == 0 {
                println!("{a}");
            }
            sum = sum.wrapping_mul(31).wrapping_add(a.len() as u64).wrapping_add(a.as_bytes()[a.len() / 2] as u64);
        }
    }
    if !print {
        println!("{sum}");
    }
}
