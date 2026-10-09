//! Compute-unit and equivalence harness for solana-program/record (SPEC 6.1, class `solana`).
//!
//!   lineage-cu cu <write|admin> <seed> <program.so>   prints total CU over the seeded steps
//!   lineage-cu equiv <seed> <program.so>              prints results and account state, never CU
//!
//! Instruction data follows the program's wire format (tag byte; Write: offset u64 LE, length u32
//! LE, bytes; Reallocate: data_length u64 LE). Every input comes from the seed: record sizes
//! (0 to 4 KB of payload), offsets, write lengths, authorities and destinations. CU is exact.

use {
    mollusk_svm::{program::loader_keys::LOADER_V3, Mollusk},
    solana_account::Account,
    solana_instruction::{AccountMeta, Instruction},
    solana_pubkey::Pubkey,
};

const STEPS: usize = 24;
const META: usize = 33; // RecordData: version u8 + authority

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
    fn bytes(&mut self, n: usize) -> Vec<u8> {
        (0..n).map(|_| self.next() as u8).collect()
    }
}

fn program_id() -> Pubkey {
    "recr1L3PCGKLbckBqMNcJhuuyU1zgo8nBhfLVsJNwr5".parse().unwrap()
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

fn record_account(m: &Mollusk, authority: Option<&Pubkey>, payload: Vec<u8>) -> Account {
    let mut data = vec![0u8; META];
    if let Some(a) = authority {
        data[0] = 1;
        data[1..META].copy_from_slice(a.as_ref());
    }
    data.extend(payload);
    Account { lamports: m.sysvars.rent.minimum_balance(data.len()), data, owner: program_id(), executable: false, rent_epoch: 0 }
}

fn ix(data: Vec<u8>, metas: Vec<AccountMeta>) -> Instruction {
    Instruction { program_id: program_id(), accounts: metas, data }
}

fn write_data(offset: u64, bytes: &[u8]) -> Vec<u8> {
    let mut d = vec![1u8];
    d.extend_from_slice(&offset.to_le_bytes());
    d.extend_from_slice(&(bytes.len() as u32).to_le_bytes());
    d.extend_from_slice(bytes);
    d
}

struct Case {
    ix: Instruction,
    accounts: Vec<(Pubkey, Account)>,
}

/// A valid Write: an initialized record of 0 to 4 KB, written at a seeded offset by its authority.
fn write_case(m: &Mollusk, rng: &mut Rng) -> Case {
    let (rec, auth) = (rng.key(), rng.key());
    let size = rng.below(4097) as usize;
    let len = if size == 0 { 0 } else { rng.below(size as u64 + 1) as usize };
    let offset = rng.below((size - len) as u64 + 1);
    let payload = rng.bytes(size);
    let bytes = rng.bytes(len);
    Case {
        ix: ix(write_data(offset, &bytes), vec![AccountMeta::new(rec, false), AccountMeta::new_readonly(auth, true)]),
        accounts: vec![(rec, record_account(m, Some(&auth), payload)), (auth, Account::default())],
    }
}

/// A valid lifecycle step: Initialize (zeroed record), SetAuthority, Reallocate (grow or no-op)
/// or CloseAccount, chosen by the seed.
fn admin_case(m: &Mollusk, rng: &mut Rng) -> Case {
    let (rec, auth, other) = (rng.key(), rng.key(), rng.key());
    let size = rng.below(512) as usize;
    let payload = rng.bytes(size);
    match rng.below(4) {
        0 => Case {
            ix: ix(vec![0], vec![AccountMeta::new(rec, false), AccountMeta::new_readonly(auth, false)]),
            accounts: vec![(rec, record_account(m, None, payload)), (auth, Account::default())],
        },
        1 => Case {
            ix: ix(vec![2], vec![AccountMeta::new(rec, false), AccountMeta::new_readonly(auth, true), AccountMeta::new_readonly(other, false)]),
            accounts: vec![(rec, record_account(m, Some(&auth), payload)), (auth, Account::default()), (other, Account::default())],
        },
        2 => {
            let target = rng.below(1024);
            let mut d = vec![4u8];
            d.extend_from_slice(&target.to_le_bytes());
            Case {
                ix: ix(d, vec![AccountMeta::new(rec, false), AccountMeta::new_readonly(auth, true)]),
                accounts: vec![(rec, record_account(m, Some(&auth), payload)), (auth, Account::default())],
            }
        }
        _ => Case {
            ix: ix(vec![3], vec![AccountMeta::new(rec, false), AccountMeta::new_readonly(auth, true), AccountMeta::new(other, false)]),
            accounts: vec![(rec, record_account(m, Some(&auth), payload)), (auth, Account::default()), (other, Account { lamports: 1 + rng.below(1_000_000), ..Account::default() })],
        },
    }
}

fn cu(kind: &str, seed: &str, so: &str) {
    let m = setup(so);
    let mut rng = Rng::from_seed(seed);
    let mut total: u64 = 0;
    for step in 0..STEPS {
        let c = match kind {
            "write" => write_case(&m, &mut rng),
            "admin" => admin_case(&m, &mut rng),
            _ => {
                eprintln!("unknown kind {kind}");
                std::process::exit(2)
            }
        };
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

/// Valid cases plus the program's failure modes: wrong or unsigned authority, uninitialized and
/// already-initialized records, records shorter than the metadata, writes past the end, malformed
/// and unknown instruction data, missing accounts, readonly or foreign-owned records.
fn equiv(seed: &str, so: &str) {
    let m = setup(so);
    let mut rng = Rng::from_seed(seed);
    for step in 0..(STEPS * 6) {
        let roll = rng.below(16);
        let mut c = if rng.below(2) == 0 { write_case(&m, &mut rng) } else { admin_case(&m, &mut rng) };
        match roll {
            0 => {
                // a different authority key; it must be supplied too, or mollusk aborts the run
                let k = rng.key();
                c.ix.accounts[1].pubkey = k;
                c.accounts.push((k, Account::default()));
            }
            1 => c.ix.accounts[1].is_signer = false,
            2 => {
                let a = &mut c.accounts[0].1;
                a.data[0] = if a.data[0] == 1 { 0 } else { 1 };
            }
            3 => {
                let l = rng.below(META as u64) as usize;
                c.accounts[0].1.data.truncate(l);
            }
            4 => {
                if c.ix.data[0] == 1 {
                    let n = c.accounts[0].1.data.len() as u64;
                    c.ix.data[1..9].copy_from_slice(&(n + rng.below(64)).to_le_bytes());
                }
            }
            5 => {
                let cut = rng.below(c.ix.data.len() as u64 + 1) as usize;
                c.ix.data.truncate(cut);
            }
            6 => c.ix.data[0] = 5 + rng.below(250) as u8,
            7 => {
                c.ix.accounts.pop();
            }
            8 => c.ix.accounts[0].is_writable = false,
            9 => c.accounts[0].1.owner = Pubkey::new_from_array([7u8; 32]),
            10 => {
                if c.ix.data[0] == 1 && c.ix.data.len() >= 13 {
                    let l = u32::from_le_bytes(c.ix.data[9..13].try_into().unwrap());
                    c.ix.data[9..13].copy_from_slice(&(l + 1 + rng.below(8) as u32).to_le_bytes());
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
            println!("  {k} {} {} {}", a.lamports, a.data.len(), hex(&a.data));
        }
    }
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    match a.get(1).map(String::as_str) {
        Some("cu") if a.len() == 5 => cu(&a[2], &a[3], &a[4]),
        Some("equiv") if a.len() == 4 => equiv(&a[2], &a[3]),
        _ => {
            eprintln!("usage: lineage-cu cu <write|admin> <seed> <program.so> | lineage-cu equiv <seed> <program.so>");
            std::process::exit(2)
        }
    }
}
