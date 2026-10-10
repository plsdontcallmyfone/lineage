//! pump.fun in LiteSVM: mainnet's Pump, PumpSwap, Pump Fees and Mayhem builds and the mainnet
//! accounts they read (`vendor/pump`, dumped by `vendor/pump/fetch.sh`, sha256 pinned below), and
//! raw instruction builders following pump.fun's IDLs (pump-public-docs 2293f9a, read 2026-10-10).
//! The TypeScript builders in packages/chain/src/pump.ts are proven against the same programs on a
//! mainnet fork (scripts/mainnet/pump-fork-proof.ts).
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::{pubkey, system_program};
use litesvm::LiteSVM;

use crate::{ata, manifest, pda_of, ATA_PROGRAM, T22, TOKEN};

pub const PUMP: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const PUMP_AMM: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
pub const PUMP_FEES: Pubkey = pubkey!("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ");
pub const MAYHEM: Pubkey = pubkey!("MAyhSmzXzV1pTf7LsNkrNwkWKTo4ougAJ1PPg47MD4e");
pub const GLOBAL: Pubkey = pubkey!("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");
pub const QUOTE_CONTROL: Pubkey = pubkey!("6z6GDdfb2AjR9ZhJmAUQ5cipJCVxQvLJhB2H8mCwTFBP");
pub const FEE_CONFIG: Pubkey = pubkey!("8Wf5TiAheLUqBrKXeYg2JtAFFMWtKdG2BSFgqUcPVwTt");
pub const AMM_FEE_CONFIG: Pubkey = pubkey!("5PHirr8joyTMp9JMm6nW7hNDVyEYdkzDqazxPD7RaTjx");
pub const AMM_GLOBAL_CONFIG: Pubkey = pubkey!("ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw");
pub const WITHDRAW_AUTHORITY: Pubkey = pubkey!("39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg");
pub const BUYBACK0: Pubkey = pubkey!("5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD");
pub const WSOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const SUPPLY: u64 = 1_000_000_000_000_000;

/// (file, sha256) of each program and fixture (mainnet, read 2026-10-10 by vendor/pump/fetch.sh).
pub const PROGRAMS: [(&str, Pubkey, &str); 4] = [
    ("pump.so", PUMP, "a4b32d322295a15666b1293e0028b9b75d688bfce10b574e1094f249f2ce9f16"),
    ("pump_amm.so", PUMP_AMM, "a8d05e6927cc6e861d3052a9bf2258ce3a4588f47307d53d0c20ecbe0b86697e"),
    ("pump_fees.so", PUMP_FEES, "73c679c8dae8d24153fdd0455b557b73662e93ab2ec88831a9e4be2b08a897a4"),
    ("mayhem.so", MAYHEM, "a87fa9f866272514e6acb852b668c4a08aeb173d56c883039991d114d1199bdb"),
];
pub const FIXTURES: [(&str, &str); 7] = [
    ("global.json", "333252d443ac0e38a0840d83fece64477c116d66d8ee77298593132a5bb90b85"),
    ("quote_control.json", "9472e034f28e3182a5ed3b925b5248b049a5db882bfabf29876286c077c86ec1"),
    ("fee_config.json", "63af11a12fe475b59c31ceec9b7077c99dcae4b79e4b26c7fa43a70d8ea4aff3"),
    ("amm_fee_config.json", "c9b0f7eccbccaba6f5c111c4e7bc6b0c390fb60daf510896134d55005e9c39e5"),
    ("amm_global_config.json", "6f1e22910d2356fe0706bddf41ea99c5ee89185f611f8125798221490704ca3f"),
    ("mayhem_global_params.json", "9d225bb8363960c866890e8b8572c45e4bdf66ab508320be50d074e633fa0979"),
    ("buyback0.json", "2df088a550ede92361fde247687fd90dc688a55c9e488afa3d8b6f1c9072510c"),
];

fn sha_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}
fn b64(s: &str) -> Vec<u8> {
    let val = |c: u8| -> u32 {
        match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a' + 26) as u32,
            b'0'..=b'9' => (c - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            _ => 0,
        }
    };
    let b: Vec<u8> = s.bytes().filter(|c| *c != b'=').collect();
    let mut out = Vec::with_capacity(b.len() * 3 / 4);
    for chunk in b.chunks(4) {
        let mut n = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            n |= val(*c) << (18 - 6 * i);
        }
        let bytes = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&bytes[..chunk.len() - 1]);
    }
    out
}

/// Loads the pinned pump.fun programs and mainnet accounts into `svm`.
pub fn install(svm: &mut LiteSVM) {
    let dir = manifest("../vendor/pump");
    for (file, id, sha) in PROGRAMS {
        let bytes = std::fs::read(dir.join(file)).unwrap_or_else(|_| panic!("vendor/pump/{file} missing: run onchain/vendor/pump/fetch.sh"));
        assert_eq!(sha_hex(&bytes), sha, "vendor/pump/{file} is not the pinned build");
        svm.add_program(id, &bytes);
    }
    for (file, sha) in FIXTURES {
        let text = std::fs::read(dir.join(file)).unwrap();
        assert_eq!(sha_hex(&text), sha, "vendor/pump/{file} is not the pinned fixture");
        let v: serde_json::Value = serde_json::from_slice(&text).unwrap();
        let a = &v["account"];
        let key: Pubkey = v["pubkey"].as_str().unwrap().parse().unwrap();
        svm.set_account(key, solana_account::Account {
            lamports: a["lamports"].as_u64().unwrap(),
            data: b64(a["data"][0].as_str().unwrap()),
            owner: a["owner"].as_str().unwrap().parse().unwrap(),
            executable: false,
            rent_epoch: 0,
        }).unwrap();
    }
    // The wrapped SOL mint (SPL Token, 9 decimals, no authority), named by every SOL-paired trade.
    if svm.get_account(&WSOL).is_none() {
        let mut data = vec![0u8; 82];
        data[44] = 9;
        data[45] = 1;
        svm.set_account(WSOL, solana_account::Account { lamports: 1_461_600, data, owner: TOKEN, executable: false, rent_epoch: 0 }).unwrap();
    }
    // Mayhem's SOL vault and Pump's withdraw authority are plain system accounts on mainnet.
    for k in [pda_of(&[b"sol-vault"], &MAYHEM), WITHDRAW_AUTHORITY] {
        svm.airdrop(&k, 1_000_000_000).unwrap();
    }
}

pub fn curve_of(mint: &Pubkey) -> Pubkey {
    pda_of(&[b"bonding-curve", mint.as_ref()], &PUMP)
}
pub fn creator_vault(creator: &Pubkey) -> Pubkey {
    pda_of(&[b"creator-vault", creator.as_ref()], &PUMP)
}
pub fn event_authority() -> Pubkey {
    pda_of(&[b"__event_authority"], &PUMP)
}
pub fn amm_event_authority() -> Pubkey {
    pda_of(&[b"__event_authority"], &PUMP_AMM)
}
pub fn pool_authority(mint: &Pubkey) -> Pubkey {
    pda_of(&[b"pool-authority", mint.as_ref()], &PUMP)
}
pub fn pool_of(mint: &Pubkey, quote: &Pubkey) -> Pubkey {
    pda_of(&[b"pool", &0u16.to_le_bytes(), pool_authority(mint).as_ref(), mint.as_ref(), quote.as_ref()], &PUMP_AMM)
}
fn disc(name: &str) -> Vec<u8> {
    use sha2::Digest;
    sha2::Sha256::digest(format!("global:{name}").as_bytes())[..8].to_vec()
}
fn w(k: Pubkey) -> AccountMeta {
    AccountMeta::new(k, false)
}
fn r(k: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(k, false)
}
fn borsh_str(d: &mut Vec<u8>, s: &str) {
    d.extend_from_slice(&(s.len() as u32).to_le_bytes());
    d.extend_from_slice(s.as_bytes());
}

/// The quote of a new coin: SOL, or a pump coin on its curve (`pool` None) or migrated.
pub enum Quote {
    Sol,
    Coin { mint: Pubkey, pool: Option<(Pubkey, Pubkey, Pubkey)> },
}

/// Pump `create_v2` (COIN_CREATION.md, CREATE_WITH_PUMP_COIN_QUOTE.md). Signers: mint, user.
pub fn create_v2_ix(mint: &Pubkey, user: &Pubkey, creator: &Pubkey, name: &str, symbol: &str, quote: &Quote, mayhem: bool, creator_fee_bps: u64,
    holder_reward: bool) -> Instruction {
    let curve = curve_of(mint);
    let sol_vault = pda_of(&[b"sol-vault"], &MAYHEM);
    let mut accounts = vec![
        AccountMeta::new(*mint, true), r(pda_of(&[b"mint-authority"], &PUMP)), w(curve), w(ata(&curve, mint, &T22)), r(GLOBAL),
        AccountMeta::new(*user, true), r(system_program::ID), r(T22), r(ATA_PROGRAM), w(MAYHEM), r(pda_of(&[b"global-params"], &MAYHEM)),
        w(sol_vault), w(pda_of(&[b"mayhem-state", mint.as_ref()], &MAYHEM)), w(ata(&sol_vault, mint, &T22)), r(event_authority()), r(PUMP),
    ];
    if let Quote::Coin { mint: q, pool } = quote {
        accounts.extend([r(*q), w(ata(&curve, q, &T22)), r(T22), r(QUOTE_CONTROL), r(curve_of(q))]);
        if let Some((p, b, qv)) = pool {
            accounts.extend([r(*p), r(*b), r(*qv)]);
        }
    }
    let mut data = disc("create_v2");
    borsh_str(&mut data, name);
    borsh_str(&mut data, symbol);
    borsh_str(&mut data, "https://example.invalid/coin.json");
    data.extend_from_slice(creator.as_ref());
    data.push(mayhem as u8);
    data.push(0);
    data.extend_from_slice(&creator_fee_bps.to_le_bytes());
    data.push(holder_reward as u8);
    Instruction { program_id: PUMP, accounts, data }
}

fn curve_trade_accounts(mint: &Pubkey, quote: &Pubkey, quote_program: &Pubkey, user: &Pubkey) -> Vec<AccountMeta> {
    let curve = curve_of(mint);
    let buyback = if *quote == WSOL { BUYBACK0 } else { ata(&BUYBACK0, quote, quote_program) };
    vec![
        r(GLOBAL), r(*mint), r(*quote), r(T22), r(*quote_program), w(curve), w(ata(&curve, mint, &T22)), w(ata(&curve, quote, quote_program)),
        AccountMeta::new(*user, true), w(ata(user, mint, &T22)), w(ata(user, quote, quote_program)),
        w(pda_of(&[b"user_volume_accumulator", user.as_ref()], &PUMP)), r(FEE_CONFIG), w(buyback), r(system_program::ID), r(event_authority()), r(PUMP),
    ]
}
/// Pump `buy_v3`: exactly `amount` tokens for at most `max_in` quote. The user's base ATA must exist.
pub fn buy_v3_ix(mint: &Pubkey, quote: &Pubkey, quote_program: &Pubkey, user: &Pubkey, amount: u64, max_in: u64) -> Instruction {
    let mut data = disc("buy_v3");
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&max_in.to_le_bytes());
    data.push(0);
    Instruction { program_id: PUMP, accounts: curve_trade_accounts(mint, quote, quote_program, user), data }
}
pub fn sell_v3_ix(mint: &Pubkey, quote: &Pubkey, quote_program: &Pubkey, user: &Pubkey, amount: u64, min_out: u64) -> Instruction {
    let mut data = disc("sell_v3");
    data.extend_from_slice(&amount.to_le_bytes());
    data.extend_from_slice(&min_out.to_le_bytes());
    Instruction { program_id: PUMP, accounts: curve_trade_accounts(mint, quote, quote_program, user), data }
}
/// Pump `sweep_creator_fee`: the curve's waiting creator fee to the creator vault (permissionless).
pub fn sweep_creator_fee_ix(payer: &Pubkey, mint: &Pubkey, quote: &Pubkey, creator: &Pubkey) -> Instruction {
    let curve = curve_of(mint);
    let vault = creator_vault(creator);
    Instruction {
        program_id: PUMP,
        accounts: vec![AccountMeta::new(*payer, true), r(GLOBAL), r(*mint), r(*quote), r(T22), r(ATA_PROGRAM), r(system_program::ID), w(curve),
            w(ata(&curve, quote, &T22)), w(vault), w(ata(&vault, quote, &T22)), r(event_authority()), r(PUMP)],
        data: disc("sweep_creator_fee"),
    }
}
/// Pump `collect_creator_fee_v2`: the creator vault's quote tokens to the creator's ATA (permissionless).
pub fn collect_creator_fee_v2_ix(creator: &Pubkey, quote: &Pubkey) -> Instruction {
    let vault = creator_vault(creator);
    Instruction {
        program_id: PUMP,
        accounts: vec![w(*creator), w(ata(creator, quote, &T22)), w(vault), w(ata(&vault, quote, &T22)), r(*quote), r(T22), r(ATA_PROGRAM),
            r(system_program::ID), r(event_authority()), r(PUMP)],
        data: disc("collect_creator_fee_v2"),
    }
}
/// Pump `migrate_v2` (permissionless once complete), with the boost vault remaining accounts.
pub fn migrate_v2_ix(user: &Pubkey, mint: &Pubkey, quote: &Pubkey, quote_program: &Pubkey) -> Instruction {
    let curve = curve_of(mint);
    let pa = pool_authority(mint);
    let pool = pool_of(mint, quote);
    let lp = pda_of(&[b"pool_lp_mint", pool.as_ref()], &PUMP_AMM);
    let boost = pda_of(&[b"boost_vault", pool.as_ref()], &PUMP_AMM);
    Instruction {
        program_id: PUMP,
        accounts: vec![r(GLOBAL), w(WITHDRAW_AUTHORITY), r(*mint), r(*quote), w(curve), w(ata(&curve, mint, &T22)), w(ata(&curve, quote, quote_program)),
            AccountMeta::new(*user, true), r(system_program::ID), r(PUMP_AMM), w(pool), w(pa), w(ata(&pa, mint, &T22)), w(ata(&pa, quote, quote_program)),
            r(AMM_GLOBAL_CONFIG), w(lp), w(ata(&pa, &lp, &T22)), w(ata(&pool, mint, &T22)), w(ata(&pool, quote, quote_program)), r(T22), r(*quote_program),
            r(T22), r(ATA_PROGRAM), r(amm_event_authority()), r(anchor_lang::solana_program::sysvar::rent::ID), r(event_authority()), r(PUMP),
            r(boost), w(ata(&boost, quote, quote_program))],
        data: disc("migrate_v2"),
    }
}
/// PumpSwap `buy_v2` on a pool quoted in a Token-2022 quote.
pub fn amm_buy_v2_ix(pool: &Pubkey, mint: &Pubkey, quote: &Pubkey, user: &Pubkey, base_out: u64, max_in: u64) -> Instruction {
    let mut data = disc("buy_v2");
    data.extend_from_slice(&base_out.to_le_bytes());
    data.extend_from_slice(&max_in.to_le_bytes());
    Instruction {
        program_id: PUMP_AMM,
        accounts: vec![w(*pool), AccountMeta::new(*user, true), r(AMM_GLOBAL_CONFIG), r(*mint), r(*quote), w(ata(user, mint, &T22)), w(ata(user, quote, &T22)),
            w(ata(pool, mint, &T22)), w(ata(pool, quote, &T22)), r(T22), r(T22), r(system_program::ID),
            w(pda_of(&[b"user_volume_accumulator", user.as_ref()], &PUMP_AMM)), r(AMM_FEE_CONFIG), w(ata(&BUYBACK0, quote, &T22)),
            r(amm_event_authority()), r(PUMP_AMM)],
        data,
    }
}
/// PumpSwap `sweep_creator_fee` + `collect_coin_creator_fee` into the coin creator's ATA.
pub fn amm_sweep_and_collect_ixs(payer: &Pubkey, pool: &Pubkey, quote: &Pubkey, coin_creator: &Pubkey) -> Vec<Instruction> {
    let vault = pda_of(&[b"creator_vault", coin_creator.as_ref()], &PUMP_AMM);
    vec![
        Instruction {
            program_id: PUMP_AMM,
            accounts: vec![AccountMeta::new(*payer, true), r(AMM_GLOBAL_CONFIG), w(*pool), r(*quote), r(T22), w(ata(pool, quote, &T22)), r(vault),
                w(ata(&vault, quote, &T22)), r(system_program::ID), r(ATA_PROGRAM), r(amm_event_authority()), r(PUMP_AMM)],
            data: disc("sweep_creator_fee"),
        },
        Instruction {
            program_id: PUMP_AMM,
            accounts: vec![r(*quote), r(T22), r(*coin_creator), r(vault), w(ata(&vault, quote, &T22)), w(ata(coin_creator, quote, &T22)),
                r(amm_event_authority()), r(PUMP_AMM)],
            data: disc("collect_coin_creator_fee"),
        },
    ]
}

/// BondingCurve fields the suites read (offsets include the discriminator).
pub struct CurveView {
    pub virtual_token: u64,
    pub virtual_quote: u64,
    pub real_token: u64,
    pub real_quote: u64,
    pub complete: bool,
    pub creator: Pubkey,
    pub quote_mint: Pubkey,
    pub creator_fee: u64,
}
pub fn curve_view(svm: &LiteSVM, mint: &Pubkey) -> CurveView {
    let d = svm.get_account(&curve_of(mint)).unwrap().data;
    let u = |o: usize| u64::from_le_bytes(d[o..o + 8].try_into().unwrap());
    let k = |o: usize| Pubkey::new_from_array(d[o..o + 32].try_into().unwrap());
    CurveView { virtual_token: u(8), virtual_quote: u(16), real_token: u(24), real_quote: u(32), complete: d[48] != 0, creator: k(49), quote_mint: k(83),
        creator_fee: u(125) }
}
/// Quote cost of exactly `amount` tokens on a curve before fees (pump's `buy` formula), and a cap 3% above.
pub fn buy_cap(svm: &LiteSVM, mint: &Pubkey, amount: u64) -> u64 {
    let c = curve_view(svm, mint);
    let net = (amount as u128 * c.virtual_quote as u128 / (c.virtual_token as u128 - amount as u128)) as u64 + 1;
    net + net / 33 + 10
}
pub const TOKEN_PROGRAM: Pubkey = TOKEN;
