//! Compute-unit and equivalence harness for solana-program/config (SPEC 6.1, class `solana`).
//!
//!   lineage-cu cu <init|store> <seed> <program.so>   prints total CU over the seeded steps
//!   lineage-cu equiv <seed> <program.so>             prints results and account data, never CU
//!
//! Every input comes from the seed: key counts (0 to 37, the program's maximum), signer flags,
//! pubkeys, trailing config payload and account slack. CU is exact.

use {
    mollusk_svm::{program::loader_keys::LOADER_V3, Mollusk},
    solana_account::Account,
    solana_instruction::{AccountMeta, Instruction},
    solana_pubkey::Pubkey,
};

const STEPS: usize = 24;
const MAX_KEYS: u64 = 37;

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
    fn key(&mut self) -> Pubkey {
        let mut b = [0u8; 32];
        for c in b.chunks_mut(8) {
            c.copy_from_slice(&self.next().to_le_bytes());
        }
        Pubkey::new_from_array(b)
    }
}

fn program_id() -> Pubkey {
    "Config1111111111111111111111111111111111111".parse().unwrap()
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

/// bincode layout of (ConfigKeys { keys: Vec<(Pubkey, bool)> }, payload): short_vec length, then
/// 33-byte entries, then the caller's config bytes. Lengths here are below 128, so one byte.
fn encode(keys: &[(Pubkey, bool)], payload: &[u8]) -> Vec<u8> {
    assert!(keys.len() < 128);
    let mut d = vec![keys.len() as u8];
    for (k, s) in keys {
        d.extend_from_slice(k.as_ref());
        d.push(*s as u8);
    }
    d.extend_from_slice(payload);
    d
}

struct Case {
    ix: Instruction,
    accounts: Vec<(Pubkey, Account)>,
}

fn account(m: &Mollusk, data: Vec<u8>, owner: Pubkey) -> Account {
    Account { lamports: m.sysvars.rent.minimum_balance(data.len()), data, owner, executable: false, rent_epoch: 0 }
}

fn random_keys(rng: &mut Rng, n: u64) -> Vec<(Pubkey, bool)> {
    (0..n).map(|_| (rng.key(), rng.below(3) == 0)).collect()
}

fn payload(rng: &mut Rng) -> Vec<u8> {
    (0..rng.below(48)).map(|_| rng.next() as u8).collect()
}

/// A valid instruction. `init`: the account is zeroed (no stored keys), so the config account
/// signs. Otherwise the account already stores keys and the update is signed by every stored
/// signer, carries the same signer set (shuffled among new non-signer keys) and a new payload.
fn valid_case(m: &Mollusk, rng: &mut Rng, init: bool) -> Case {
    let config = rng.key();
    let n = rng.below(MAX_KEYS + 1);
    let new_keys = random_keys(rng, n);
    let pay = payload(rng);
    let slack = rng.below(32) as usize;
    let mut config_signs = true;
    let state = if init {
        vec![0u8; encode(&new_keys, &pay).len() + slack]
    } else {
        // stored keys: the signers of new_keys plus some other non-signers
        let mut stored: Vec<(Pubkey, bool)> = new_keys.iter().filter(|(_, s)| *s).cloned().collect();
        let extra = rng.below(MAX_KEYS + 1 - n.min(MAX_KEYS)).min(MAX_KEYS - stored.len() as u64);
        stored.extend(random_keys(rng, extra).into_iter().map(|(k, _)| (k, false)));
        // rotate so stored order differs from new order
        if !stored.is_empty() {
            let r = rng.below(stored.len() as u64) as usize;
            stored.rotate_left(r);
        }
        let old_pay = payload(rng);
        let mut s = encode(&stored, &old_pay);
        let need = encode(&new_keys, &pay).len();
        if s.len() < need + slack {
            s.resize(need + slack, 0);
        }
        if stored.iter().any(|(_, sg)| *sg) {
            config_signs = rng.below(2) == 0;
        }
        s
    };
    let data = encode(&new_keys, &pay);
    let mut metas = vec![AccountMeta { pubkey: config, is_signer: config_signs, is_writable: true }];
    let mut accounts = vec![(config, account(m, state, program_id()))];
    for (k, s) in &new_keys {
        if *s {
            metas.push(AccountMeta::new_readonly(*k, true));
            accounts.push((*k, Account::default()));
        }
    }
    Case { ix: Instruction { program_id: program_id(), accounts: metas, data }, accounts }
}

fn cu(kind: &str, seed: &str, so: &str) {
    let init = match kind {
        "init" => true,
        "store" => false,
        _ => {
            eprintln!("unknown kind {kind}");
            std::process::exit(2)
        }
    };
    let m = setup(so);
    let mut rng = Rng::from_seed(seed);
    let mut total: u64 = 0;
    for step in 0..STEPS {
        let c = valid_case(&m, &mut rng, init);
        let r = m.process_instruction(&c.ix, &c.accounts);
        if r.program_result.is_err() {
            eprintln!("step {step} failed: {:?}", r.raw_result);
            std::process::exit(1);
        }
        total += r.compute_units_consumed;
    }
    println!("{total}");
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// Valid cases plus the program's failure modes: duplicate keys, missing or wrong signers, a
/// readonly or foreign-owned account, oversized data, malformed lengths and truncated state.
fn equiv(seed: &str, so: &str) {
    let m = setup(so);
    let mut rng = Rng::from_seed(seed);
    for step in 0..(STEPS * 4) {
        let roll = rng.below(16);
        let init = rng.below(2) == 0;
        let mut c = valid_case(&m, &mut rng, init);
        match roll {
            0 => {
                // duplicate a key
                let n = c.ix.data[0] as usize;
                if n > 0 && n < MAX_KEYS as usize {
                    let first: Vec<u8> = c.ix.data[1..34].to_vec();
                    let mut d = vec![(n + 1) as u8];
                    d.extend_from_slice(&first);
                    d.extend_from_slice(&c.ix.data[1..]);
                    c.ix.data = d;
                    let acct = &mut c.accounts[0].1;
                    if acct.data.len() < c.ix.data.len() {
                        acct.data.resize(c.ix.data.len(), 0);
                    }
                }
            }
            1 => {
                // drop the last signer
                if c.ix.accounts.len() > 1 {
                    c.ix.accounts.pop();
                    c.accounts.pop();
                }
            }
            2 => c.ix.accounts.iter_mut().skip(1).for_each(|a| a.is_signer = false),
            3 => c.ix.accounts[0].is_writable = false,
            4 => c.accounts[0].1.owner = Pubkey::new_from_array([1u8; 32]),
            5 => {
                let len = c.ix.data.len();
                c.accounts[0].1.data.truncate(len.saturating_sub(1 + rng.below(8) as usize));
            }
            6 => c.ix.data[0] = 38 + rng.below(200) as u8,
            7 => {
                let cut = rng.below(c.ix.data.len() as u64) as usize;
                c.ix.data.truncate(cut);
            }
            8 => c.ix.accounts[0].is_signer = false,
            9 => {
                // a stored length longer than the stored data
                let a = &mut c.accounts[0].1;
                if !a.data.is_empty() {
                    a.data[0] = 37;
                    let l = a.data.len().min(40);
                    a.data.truncate(l);
                }
            }
            _ => {}
        }
        let r = m.process_instruction(&c.ix, &c.accounts);
        let res = match &r.raw_result {
            Ok(()) => "ok".to_string(),
            Err(e) => format!("err {e:?}"),
        };
        println!("step {step} case {roll} in {} -> {res} ret {}", hex(&c.ix.data), hex(&r.return_data));
        for (k, a) in &r.resulting_accounts {
            println!("  {k} {} {}", a.lamports, hex(&a.data));
        }
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    match a.get(1).map(String::as_str) {
        Some("cu") if a.len() == 5 => cu(&a[2], &a[3], &a[4]),
        Some("equiv") if a.len() == 4 => equiv(&a[2], &a[3]),
        _ => {
            eprintln!("usage: lineage-cu cu <init|store> <seed> <program.so> | lineage-cu equiv <seed> <program.so>");
            std::process::exit(2)
        }
    }
}
