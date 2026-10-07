//! Compute-unit and equivalence harness for cu-tally (SPEC 6.1, class `solana`).
//!
//!   lineage-cu cu <record|digest|sort|all> <seed> <program.so>   prints total CU (one integer)
//!   lineage-cu equiv <seed> <program.so>                         prints outputs, never CU
//!
//! Inputs come only from the seed. CU is exact: the SVM meters every instruction.

use {
    mollusk_svm::{program::loader_keys::LOADER_V3, Mollusk},
    solana_account::Account,
    solana_instruction::{AccountMeta, Instruction},
    solana_pubkey::Pubkey,
};

const STATE_LEN: usize = 64 + 4 * 64;
const STEPS: usize = 24;

struct Rng(u64);
impl Rng {
    fn from_seed(seed: &str) -> Rng {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in seed.bytes() {
            h ^= b as u64;
            h = h.wrapping_mul(0x0000_0100_0000_01b3);
        }
        Rng(h)
    }
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
    fn below(&mut self, n: u64) -> u64 {
        self.next() % n
    }
}

fn program_id() -> Pubkey {
    Pubkey::new_from_array([7u8; 32])
}
fn state_key() -> Pubkey {
    Pubkey::new_from_array([9u8; 32])
}

fn setup(so: &str) -> Mollusk {
    std::env::set_var("RUST_LOG", "error");
    let elf = std::fs::read(so).unwrap_or_else(|e| {
        eprintln!("cannot read {so}: {e}");
        std::process::exit(3)
    });
    let mut m = Mollusk::default();
    m.add_program_with_loader_and_elf(&program_id(), &LOADER_V3, &elf);
    m
}

fn state_account(m: &Mollusk, owner: Pubkey) -> Account {
    Account {
        lamports: m.sysvars.rent.minimum_balance(STATE_LEN),
        data: vec![0u8; STATE_LEN],
        owner,
        executable: false,
        rent_epoch: 0,
    }
}

/// One seeded, valid instruction payload of the given kind.
fn payload(kind: u8, rng: &mut Rng) -> Vec<u8> {
    let mut d = vec![kind];
    match kind {
        0 => {
            let n = 1 + rng.below(40);
            for _ in 0..n {
                // mix of small and full-width values
                let v = if rng.below(4) == 0 { rng.below(1000) } else { rng.next() };
                d.extend_from_slice(&v.to_le_bytes());
            }
        }
        1 => {
            let n = rng.below(600);
            for _ in 0..n {
                d.push(rng.next() as u8);
            }
        }
        _ => {
            let n = 1 + rng.below(64);
            let spread = 1 + rng.below(1 << 20);
            for _ in 0..n {
                d.extend_from_slice(&(rng.below(spread) as u32).to_le_bytes());
            }
        }
    }
    d
}

fn ix(data: Vec<u8>, writable: bool) -> Instruction {
    let meta = if writable { AccountMeta::new(state_key(), false) } else { AccountMeta::new_readonly(state_key(), false) };
    Instruction { program_id: program_id(), accounts: vec![meta], data }
}

fn cu(kind: &str, seed: &str, so: &str) {
    let kinds: Vec<u8> = match kind {
        "record" => vec![0],
        "digest" => vec![1],
        "sort" => vec![2],
        "all" => vec![0, 1, 2],
        _ => {
            eprintln!("unknown kind {kind}");
            std::process::exit(2)
        }
    };
    let m = setup(so);
    let mut rng = Rng::from_seed(seed);
    let mut acct = state_account(&m, program_id());
    let mut total: u64 = 0;
    for step in 0..STEPS {
        for &k in &kinds {
            let r = m.process_instruction(&ix(payload(k, &mut rng), true), &[(state_key(), acct.clone())]);
            if r.program_result.is_err() {
                eprintln!("step {step} kind {k} failed: {:?}", r.raw_result);
                std::process::exit(1);
            }
            total += r.compute_units_consumed;
            acct = r.resulting_accounts[0].1.clone();
        }
    }
    println!("{total}");
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn equiv(seed: &str, so: &str) {
    let m = setup(so);
    let mut rng = Rng::from_seed(seed);
    let mut acct = state_account(&m, program_id());
    for step in 0..(STEPS * 3) {
        // mostly valid inputs, plus malformed ones and bad account setups
        let roll = rng.below(20);
        let (data, writable, owner) = match roll {
            0 => (vec![], true, program_id()),
            1 => (vec![3, 1, 2], true, program_id()),
            2 => {
                let mut d = payload(0, &mut rng);
                d.push(1);
                (d, true, program_id())
            }
            3 => {
                let mut d = vec![2];
                for _ in 0..(65 + rng.below(10)) {
                    d.extend_from_slice(&(rng.next() as u32).to_le_bytes());
                }
                (d, true, program_id())
            }
            4 => (payload(1, &mut rng), false, program_id()),
            5 => (payload(0, &mut rng), true, Pubkey::new_from_array([1u8; 32])),
            _ => (payload((roll % 3) as u8, &mut rng), true, program_id()),
        };
        let mut a = acct.clone();
        a.owner = owner;
        let r = m.process_instruction(&ix(data.clone(), writable), &[(state_key(), a)]);
        let res = match &r.raw_result {
            Ok(()) => "ok".to_string(),
            Err(e) => format!("err {e:?}"),
        };
        println!("step {step} in {} -> {res} ret {}", hex(&data), hex(&r.return_data));
        if r.raw_result.is_ok() && owner == program_id() {
            acct = r.resulting_accounts[0].1.clone();
        }
        println!("  state {}", hex(&acct.data));
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    match a.get(1).map(String::as_str) {
        Some("cu") if a.len() == 5 => cu(&a[2], &a[3], &a[4]),
        Some("equiv") if a.len() == 4 => equiv(&a[2], &a[3]),
        _ => {
            eprintln!("usage: lineage-cu cu <record|digest|sort|all> <seed> <program.so> | lineage-cu equiv <seed> <program.so>");
            std::process::exit(2)
        }
    }
}
