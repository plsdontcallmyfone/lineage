//! Meteora DBC and DAMM v2 interface: program and PDA addresses, account readers that check owner,
//! discriminator and size before reading fixed offsets, and raw CPIs (no Meteora crate, so the
//! build stays offline). The pattern, addresses and offsets follow the read-only reference launch
//! program on this machine (`~/instance-network/onchain/launch`, DBC `release_0.2.2`, DAMM v2
//! `release_0.2.5`); the LiteSVM suite runs the real programs dumped from devnet and checks every
//! offset used here against what they write. Offsets include the 8-byte discriminator.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{
    instruction::{AccountMeta, Instruction},
    program::invoke_signed,
};

use crate::LaunchError;

pub const DBC_PROGRAM_ID: Pubkey = pubkey!("dbcij3LWUppWqq96dh6gJWwBifmcGfLSB5D4DuSMaqN");
pub const DAMM_V2_PROGRAM_ID: Pubkey = pubkey!("cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG");
/// DBC PDA ["pool_authority"]: owns every curve vault and creates the migrated DAMM v2 pool.
pub const DBC_POOL_AUTHORITY: Pubkey = pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");
/// DBC PDA ["__event_authority"].
pub const DBC_EVENT_AUTHORITY: Pubkey = pubkey!("8Ks12pbrD6PXxfty1hVQiE9sc289zgU1zHkvXhrSdriF");
/// DAMM v2 PDA ["pool_authority"].
pub const DAMM_POOL_AUTHORITY: Pubkey = pubkey!("HLnpSz9h2S4hiLQ43rnSD9XkcUThA7B8hQMKmDaiTLcC");
/// DAMM v2 PDA ["__event_authority"].
pub const DAMM_EVENT_AUTHORITY: Pubkey = pubkey!("3rmHSu74h1ZcmAisVcWerTCiRDQbUrBKmcwptYGjHfet");

/// sha256("global:<name>")[..8].
pub mod ix {
    pub const DBC_INITIALIZE_VIRTUAL_POOL_WITH_TOKEN2022: [u8; 8] = [0xa9, 0x76, 0x33, 0x4e, 0x91, 0x6e, 0xdc, 0x9b];
    pub const DBC_CLAIM_TRADING_FEE: [u8; 8] = [0x08, 0xec, 0x59, 0x31, 0x98, 0x7d, 0xb1, 0x51];
    pub const DBC_PARTNER_WITHDRAW_SURPLUS: [u8; 8] = [0xa8, 0xad, 0x48, 0x64, 0xc9, 0x62, 0x26, 0x5c];
    pub const DAMM_CLAIM_POSITION_FEE: [u8; 8] = [0xb4, 0x26, 0x9a, 0x11, 0x85, 0x21, 0xa2, 0xd3];
}
/// sha256("account:<Name>")[..8].
pub mod account_disc {
    pub const DBC_POOL_CONFIG: [u8; 8] = [0x1a, 0x6c, 0x0e, 0x7b, 0x74, 0xe6, 0x81, 0x2b];
    pub const DBC_VIRTUAL_POOL: [u8; 8] = [0xd5, 0xe0, 0x05, 0xd1, 0x62, 0x45, 0x77, 0x5c];
    pub const DAMM_POOL: [u8; 8] = [0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc];
    pub const DAMM_POSITION: [u8; 8] = [0xaa, 0xbc, 0x8f, 0xe4, 0x7a, 0x40, 0xf7, 0xd0];
    pub const DAMM_CONFIG: [u8; 8] = [0x9b, 0x0c, 0xaa, 0xe0, 0x1e, 0xfa, 0xcc, 0x82];
}

/// DBC `MigrationProgress::CreatedPool`.
pub const DBC_MIGRATION_CREATED_POOL: u8 = 3;

fn read_u64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn read_u128(d: &[u8], o: usize) -> u128 {
    u128::from_le_bytes(d[o..o + 16].try_into().unwrap())
}
fn read_key(d: &[u8], o: usize) -> Pubkey {
    Pubkey::new_from_array(d[o..o + 32].try_into().unwrap())
}
fn checked<'a>(info: &'a AccountInfo, owner: &Pubkey, len: usize, disc: &[u8; 8]) -> Result<std::cell::Ref<'a, &'a mut [u8]>> {
    require_keys_eq!(*info.owner, *owner, LaunchError::MeteoraAccountInvalid);
    let data = info.try_borrow_data()?;
    require!(data.len() == len && data[..8] == disc[..], LaunchError::MeteoraAccountInvalid);
    Ok(data)
}

// ---------- DBC PoolConfig ----------

pub const DBC_CONFIG_LEN: usize = 8 + 1040;
pub mod dbc_config {
    pub const QUOTE_MINT: usize = 8;
    pub const FEE_CLAIMER: usize = 40;
    pub const LEFTOVER_RECEIVER: usize = 72;
    pub const COLLECT_FEE_MODE: usize = 232;
    pub const MIGRATION_OPTION: usize = 233;
    pub const TOKEN_TYPE: usize = 237;
    pub const QUOTE_TOKEN_FLAG: usize = 238;
    pub const PARTNER_PERMANENT_LOCKED: usize = 239;
    pub const CREATOR_PERMANENT_LOCKED: usize = 241;
    pub const CREATOR_TRADING_FEE_PERCENTAGE: usize = 245;
    pub const MIGRATION_QUOTE_THRESHOLD: usize = 264;
    pub const SQRT_START_PRICE: usize = 392;
}

/// What a launch needs of the admin's DBC config (SPEC 13.7): quoted in `$LINE`, our authority
/// PDA as fee claimer and leftover receiver, fees collected in the quote token, migration to DAMM
/// v2 with 100% of the LP permanently locked to the partner (the authority), no creator fee share
/// (the creator is the same PDA, so nothing is left unclaimed), Token-2022 agent mints.
pub struct DbcConfigView {
    pub migration_quote_threshold: u64,
    pub sqrt_start_price: u128,
}
pub fn check_dbc_config(info: &AccountInfo, line_mint: &Pubkey, line_token_program: &Pubkey, authority: &Pubkey) -> Result<DbcConfigView> {
    use dbc_config as c;
    let d = checked(info, &DBC_PROGRAM_ID, DBC_CONFIG_LEN, &account_disc::DBC_POOL_CONFIG).map_err(|_| error!(LaunchError::DbcConfigInvalid))?;
    let flag = if *line_token_program == anchor_spl::token::ID { 0 } else { 1 };
    require!(read_key(&d, c::QUOTE_MINT) == *line_mint && read_key(&d, c::FEE_CLAIMER) == *authority
        && read_key(&d, c::LEFTOVER_RECEIVER) == *authority, LaunchError::DbcConfigInvalid);
    require!(d[c::COLLECT_FEE_MODE] == 0 && d[c::MIGRATION_OPTION] == 1 && d[c::TOKEN_TYPE] == 1 && d[c::QUOTE_TOKEN_FLAG] == flag
        && d[c::PARTNER_PERMANENT_LOCKED] == 100 && d[c::CREATOR_PERMANENT_LOCKED] == 0 && d[c::CREATOR_TRADING_FEE_PERCENTAGE] == 0,
        LaunchError::DbcConfigInvalid);
    Ok(DbcConfigView { migration_quote_threshold: read_u64(&d, c::MIGRATION_QUOTE_THRESHOLD), sqrt_start_price: read_u128(&d, c::SQRT_START_PRICE) })
}
/// The migration quote threshold of a DBC config (owner, discriminator and size checked).
pub fn dbc_config_threshold(info: &AccountInfo) -> Result<u64> {
    let d = checked(info, &DBC_PROGRAM_ID, DBC_CONFIG_LEN, &account_disc::DBC_POOL_CONFIG).map_err(|_| error!(LaunchError::DbcConfigInvalid))?;
    Ok(read_u64(&d, dbc_config::MIGRATION_QUOTE_THRESHOLD))
}

// ---------- DBC VirtualPool ----------

pub const DBC_POOL_LEN: usize = 8 + 416;
pub struct DbcPool {
    pub config: Pubkey,
    pub creator: Pubkey,
    pub base_mint: Pubkey,
    pub base_vault: Pubkey,
    pub quote_vault: Pubkey,
    pub quote_reserve: u64,
    pub is_migrated: u8,
    pub is_partner_withdraw_surplus: u8,
    pub migration_progress: u8,
}
pub fn read_dbc_pool(info: &AccountInfo) -> Result<DbcPool> {
    let d = checked(info, &DBC_PROGRAM_ID, DBC_POOL_LEN, &account_disc::DBC_VIRTUAL_POOL)?;
    Ok(DbcPool {
        config: read_key(&d, 72),
        creator: read_key(&d, 104),
        base_mint: read_key(&d, 136),
        base_vault: read_key(&d, 168),
        quote_vault: read_key(&d, 200),
        quote_reserve: read_u64(&d, 240),
        is_migrated: d[305],
        is_partner_withdraw_surplus: d[306],
        migration_progress: d[308],
    })
}

// ---------- DAMM v2 ----------

pub const DAMM_POOL_LEN: usize = 8 + 1104;
pub struct DammPool {
    pub token_a_mint: Pubkey,
    pub token_b_mint: Pubkey,
    pub creator: Pubkey,
    /// All of the pool's liquidity (every position shares the one price range).
    pub liquidity: u128,
    /// The part of it every position has permanently locked.
    pub permanent_lock_liquidity: u128,
}
pub fn read_damm_pool(info: &AccountInfo) -> Result<DammPool> {
    let d = checked(info, &DAMM_V2_PROGRAM_ID, DAMM_POOL_LEN, &account_disc::DAMM_POOL)?;
    Ok(DammPool { token_a_mint: read_key(&d, 168), token_b_mint: read_key(&d, 200), creator: read_key(&d, 648), liquidity: read_u128(&d, 360),
        permanent_lock_liquidity: read_u128(&d, 552) })
}
pub const DAMM_POSITION_LEN: usize = 8 + 400;
pub struct DammPosition {
    pub pool: Pubkey,
    pub nft_mint: Pubkey,
    pub unlocked_liquidity: u128,
    pub vested_liquidity: u128,
    pub permanent_locked_liquidity: u128,
}
pub fn read_damm_position(info: &AccountInfo) -> Result<DammPosition> {
    let d = checked(info, &DAMM_V2_PROGRAM_ID, DAMM_POSITION_LEN, &account_disc::DAMM_POSITION)?;
    Ok(DammPosition {
        pool: read_key(&d, 8),
        nft_mint: read_key(&d, 40),
        unlocked_liquidity: read_u128(&d, 152),
        vested_liquidity: read_u128(&d, 168),
        permanent_locked_liquidity: read_u128(&d, 184),
    })
}
pub const DAMM_CONFIG_LEN: usize = 8 + 320;
/// A DAMM v2 config only DBC's pool authority may create pools with (offset 40), so a pool at
/// its PDA can only come from DBC's migration.
pub fn check_dbc_only_damm_config(info: &AccountInfo) -> Result<()> {
    let d = checked(info, &DAMM_V2_PROGRAM_ID, DAMM_CONFIG_LEN, &account_disc::DAMM_CONFIG).map_err(|_| error!(LaunchError::DammPoolUnexpected))?;
    require_keys_eq!(read_key(&d, 40), DBC_POOL_AUTHORITY, LaunchError::DammPoolUnexpected);
    Ok(())
}
/// DAMM v2 pool PDA: ["pool", config, max(mint), min(mint)].
pub fn damm_pool_address(config: &Pubkey, mint_a: &Pubkey, mint_b: &Pubkey) -> Pubkey {
    let (hi, lo) = if mint_a > mint_b { (mint_a, mint_b) } else { (mint_b, mint_a) };
    Pubkey::find_program_address(&[b"pool", config.as_ref(), hi.as_ref(), lo.as_ref()], &DAMM_V2_PROGRAM_ID).0
}
/// DAMM v2 PDA holding a position's NFT: ["position_nft_account", nft_mint].
pub fn position_nft_account(nft_mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"position_nft_account", nft_mint.as_ref()], &DAMM_V2_PROGRAM_ID).0
}

// ---------- CPIs ----------

fn call(program: &Pubkey, metas: Vec<AccountMeta>, data: Vec<u8>, infos: &[AccountInfo], signers: &[&[&[u8]]]) -> Result<()> {
    invoke_signed(&Instruction { program_id: *program, accounts: metas, data }, infos, signers).map_err(Into::into)
}
fn w(k: &AccountInfo) -> AccountMeta {
    AccountMeta::new(*k.key, false)
}
fn r(k: &AccountInfo) -> AccountMeta {
    AccountMeta::new_readonly(*k.key, false)
}
fn borsh_str(out: &mut Vec<u8>, s: &str) {
    out.extend_from_slice(&(s.len() as u32).to_le_bytes());
    out.extend_from_slice(s.as_bytes());
}

pub struct DbcInitAccounts<'a, 'info> {
    pub config: &'a AccountInfo<'info>,
    pub pool_authority: &'a AccountInfo<'info>,
    pub creator: &'a AccountInfo<'info>,
    pub base_mint: &'a AccountInfo<'info>,
    pub quote_mint: &'a AccountInfo<'info>,
    pub pool: &'a AccountInfo<'info>,
    pub base_vault: &'a AccountInfo<'info>,
    pub quote_vault: &'a AccountInfo<'info>,
    pub payer: &'a AccountInfo<'info>,
    pub token_quote_program: &'a AccountInfo<'info>,
    pub token_program: &'a AccountInfo<'info>,
    pub system_program: &'a AccountInfo<'info>,
    pub event_authority: &'a AccountInfo<'info>,
    pub program: &'a AccountInfo<'info>,
}
/// DBC `initialize_virtual_pool_with_token2022`: DBC creates the Token-2022 agent mint (a fresh
/// signer) with its metadata, mints the supply into its vault and revokes the mint authority.
/// `creator` (our authority PDA) signs.
pub fn dbc_initialize_pool(a: DbcInitAccounts, name: &str, symbol: &str, uri: &str, signers: &[&[&[u8]]]) -> Result<()> {
    let metas = vec![
        r(a.config), r(a.pool_authority), AccountMeta::new_readonly(*a.creator.key, true), AccountMeta::new(*a.base_mint.key, true),
        r(a.quote_mint), w(a.pool), w(a.base_vault), w(a.quote_vault), AccountMeta::new(*a.payer.key, true),
        r(a.token_quote_program), r(a.token_program), r(a.system_program), r(a.event_authority), r(a.program),
    ];
    let infos = vec![a.config.clone(), a.pool_authority.clone(), a.creator.clone(), a.base_mint.clone(), a.quote_mint.clone(), a.pool.clone(),
        a.base_vault.clone(), a.quote_vault.clone(), a.payer.clone(), a.token_quote_program.clone(), a.token_program.clone(),
        a.system_program.clone(), a.event_authority.clone(), a.program.clone()];
    let mut data = ix::DBC_INITIALIZE_VIRTUAL_POOL_WITH_TOKEN2022.to_vec();
    borsh_str(&mut data, name);
    borsh_str(&mut data, symbol);
    borsh_str(&mut data, uri);
    call(&DBC_PROGRAM_ID, metas, data, &infos, signers)
}

pub struct DbcClaimAccounts<'a, 'info> {
    pub pool_authority: &'a AccountInfo<'info>,
    pub config: &'a AccountInfo<'info>,
    pub pool: &'a AccountInfo<'info>,
    /// Receives nothing (max base amount 0).
    pub base_destination: &'a AccountInfo<'info>,
    pub quote_destination: &'a AccountInfo<'info>,
    pub base_vault: &'a AccountInfo<'info>,
    pub quote_vault: &'a AccountInfo<'info>,
    pub base_mint: &'a AccountInfo<'info>,
    pub quote_mint: &'a AccountInfo<'info>,
    pub fee_claimer: &'a AccountInfo<'info>,
    pub token_base_program: &'a AccountInfo<'info>,
    pub token_quote_program: &'a AccountInfo<'info>,
    pub event_authority: &'a AccountInfo<'info>,
    pub program: &'a AccountInfo<'info>,
}
/// DBC `claim_trading_fee` for the partner (our authority), quote side only.
pub fn dbc_claim_trading_fee(a: &DbcClaimAccounts, signers: &[&[&[u8]]]) -> Result<()> {
    let metas = vec![
        r(a.pool_authority), r(a.config), w(a.pool), w(a.base_destination), w(a.quote_destination), w(a.base_vault), w(a.quote_vault),
        r(a.base_mint), r(a.quote_mint), AccountMeta::new_readonly(*a.fee_claimer.key, true), r(a.token_base_program),
        r(a.token_quote_program), r(a.event_authority), r(a.program),
    ];
    let mut data = ix::DBC_CLAIM_TRADING_FEE.to_vec();
    data.extend_from_slice(&0u64.to_le_bytes());
    data.extend_from_slice(&u64::MAX.to_le_bytes());
    let infos = [a.pool_authority.clone(), a.config.clone(), a.pool.clone(), a.base_destination.clone(), a.quote_destination.clone(),
        a.base_vault.clone(), a.quote_vault.clone(), a.base_mint.clone(), a.quote_mint.clone(), a.fee_claimer.clone(),
        a.token_base_program.clone(), a.token_quote_program.clone(), a.event_authority.clone(), a.program.clone()];
    call(&DBC_PROGRAM_ID, metas, data, &infos, signers)
}
/// DBC `partner_withdraw_surplus`: the partner's share of any quote raised above the threshold.
pub fn dbc_partner_withdraw_surplus(a: &DbcClaimAccounts, signers: &[&[&[u8]]]) -> Result<()> {
    let metas = vec![
        r(a.pool_authority), r(a.config), w(a.pool), w(a.quote_destination), w(a.quote_vault), r(a.quote_mint),
        AccountMeta::new_readonly(*a.fee_claimer.key, true), r(a.token_quote_program), r(a.event_authority), r(a.program),
    ];
    let infos = [a.pool_authority.clone(), a.config.clone(), a.pool.clone(), a.quote_destination.clone(), a.quote_vault.clone(),
        a.quote_mint.clone(), a.fee_claimer.clone(), a.token_quote_program.clone(), a.event_authority.clone(), a.program.clone()];
    call(&DBC_PROGRAM_ID, metas, ix::DBC_PARTNER_WITHDRAW_SURPLUS.to_vec(), &infos, signers)
}

pub struct DammClaimAccounts<'a, 'info> {
    pub pool_authority: &'a AccountInfo<'info>,
    pub pool: &'a AccountInfo<'info>,
    pub position: &'a AccountInfo<'info>,
    pub dest_a: &'a AccountInfo<'info>,
    pub dest_b: &'a AccountInfo<'info>,
    pub token_a_vault: &'a AccountInfo<'info>,
    pub token_b_vault: &'a AccountInfo<'info>,
    pub token_a_mint: &'a AccountInfo<'info>,
    pub token_b_mint: &'a AccountInfo<'info>,
    pub nft_account: &'a AccountInfo<'info>,
    pub owner: &'a AccountInfo<'info>,
    pub token_a_program: &'a AccountInfo<'info>,
    pub token_b_program: &'a AccountInfo<'info>,
    pub event_authority: &'a AccountInfo<'info>,
    pub program: &'a AccountInfo<'info>,
}
/// DAMM v2 `claim_position_fee`, signed by the position NFT's owner (our authority).
pub fn damm_claim_position_fee(a: &DammClaimAccounts, signers: &[&[&[u8]]]) -> Result<()> {
    let metas = vec![
        r(a.pool_authority), r(a.pool), w(a.position), w(a.dest_a), w(a.dest_b), w(a.token_a_vault), w(a.token_b_vault),
        r(a.token_a_mint), r(a.token_b_mint), r(a.nft_account), AccountMeta::new_readonly(*a.owner.key, true),
        r(a.token_a_program), r(a.token_b_program), r(a.event_authority), r(a.program),
    ];
    let infos = [a.pool_authority.clone(), a.pool.clone(), a.position.clone(), a.dest_a.clone(), a.dest_b.clone(), a.token_a_vault.clone(),
        a.token_b_vault.clone(), a.token_a_mint.clone(), a.token_b_mint.clone(), a.nft_account.clone(), a.owner.clone(),
        a.token_a_program.clone(), a.token_b_program.clone(), a.event_authority.clone(), a.program.clone()];
    call(&DAMM_V2_PROGRAM_ID, metas, ix::DAMM_CLAIM_POSITION_FEE.to_vec(), &infos, signers)
}
