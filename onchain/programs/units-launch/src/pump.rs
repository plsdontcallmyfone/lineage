//! pump.fun interface (docs/plans/PUMPFUN-LAUNCHES.md): program ids, PDAs and account readers that
//! check owner, address, discriminator and length before reading fixed offsets. This program never
//! calls pump.fun: a launch is attached by reading the bonding curve that the same transaction's
//! top-level `create_v2` wrote (owner decision 2026-10-10, D2 option b), and fees reach us through
//! pump.fun's own permissionless sweeps and collects into the agent's creator PDA. Layouts follow
//! pump.fun's IDLs at github.com/pump-fun/pump-public-docs commit 2293f9a (read 2026-10-10); new
//! fields are only ever appended, so readers require a minimum length, not an exact one. The
//! LiteSVM suite runs mainnet's own Pump and PumpSwap builds and checks every offset used here.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{load_current_index_checked, load_instruction_at_checked};

use crate::LaunchError;

pub const PUMP_PROGRAM_ID: Pubkey = pubkey!("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
pub const PUMP_AMM_PROGRAM_ID: Pubkey = pubkey!("pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA");
/// Pump PDA ["global"].
pub const PUMP_GLOBAL: Pubkey = pubkey!("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf");

/// sha256("global:create_v2")[..8].
pub const CREATE_V2: [u8; 8] = [214, 144, 76, 236, 95, 139, 49, 180];
/// sha256("account:BondingCurve")[..8].
pub const BONDING_CURVE_DISC: [u8; 8] = [23, 183, 248, 55, 96, 216, 172, 96];
/// sha256("account:Global")[..8].
pub const GLOBAL_DISC: [u8; 8] = [167, 232, 232, 177, 200, 108, 114, 127];
/// sha256("account:Pool")[..8] (PumpSwap).
pub const POOL_DISC: [u8; 8] = [241, 154, 109, 4, 17, 177, 109, 188];

fn read_u64(d: &[u8], o: usize) -> u64 {
    u64::from_le_bytes(d[o..o + 8].try_into().unwrap())
}
fn read_key(d: &[u8], o: usize) -> Pubkey {
    Pubkey::new_from_array(d[o..o + 32].try_into().unwrap())
}
fn checked<'a>(info: &'a AccountInfo, owner: &Pubkey, min_len: usize, disc: &[u8; 8]) -> Result<std::cell::Ref<'a, &'a mut [u8]>> {
    require_keys_eq!(*info.owner, *owner, LaunchError::PumpAccountInvalid);
    let data = info.try_borrow_data()?;
    require!(data.len() >= min_len && data[..8] == disc[..], LaunchError::PumpAccountInvalid);
    Ok(data)
}

pub fn bonding_curve_address(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"bonding-curve", mint.as_ref()], &PUMP_PROGRAM_ID).0
}
/// The canonical PumpSwap pool a migration creates: ["pool", 0u16, pool_authority, mint, quote] of
/// PumpSwap, where pool_authority is Pump's ["pool-authority", mint].
pub fn canonical_pool(mint: &Pubkey, quote: &Pubkey) -> (Pubkey, Pubkey) {
    let authority = Pubkey::find_program_address(&[b"pool-authority", mint.as_ref()], &PUMP_PROGRAM_ID).0;
    let pool = Pubkey::find_program_address(&[b"pool", &0u16.to_le_bytes(), authority.as_ref(), mint.as_ref(), quote.as_ref()], &PUMP_AMM_PROGRAM_ID).0;
    (pool, authority)
}

/// `BondingCurve` (offsets include the discriminator; 166 bytes on mainnet 2026-10-10).
pub const CURVE_MIN_LEN: usize = 166;
pub struct Curve {
    pub real_token_reserves: u64,
    pub real_quote_reserves: u64,
    pub token_total_supply: u64,
    pub complete: bool,
    pub creator: Pubkey,
    pub is_mayhem_mode: bool,
    pub is_cashback_coin: bool,
    pub quote_mint: Pubkey,
    pub creator_fee_bps: u64,
    pub is_holder_reward: bool,
    pub depth: u8,
}
/// The bonding curve of `mint`: owned by Pump, at Pump's PDA for the mint, with the curve discriminator.
pub fn read_curve(info: &AccountInfo, mint: &Pubkey) -> Result<Curve> {
    require_keys_eq!(info.key(), bonding_curve_address(mint), LaunchError::PumpAccountInvalid);
    let d = checked(info, &PUMP_PROGRAM_ID, CURVE_MIN_LEN, &BONDING_CURVE_DISC)?;
    Ok(Curve {
        real_token_reserves: read_u64(&d, 24),
        real_quote_reserves: read_u64(&d, 32),
        token_total_supply: read_u64(&d, 40),
        complete: d[48] != 0,
        creator: read_key(&d, 49),
        is_mayhem_mode: d[81] != 0,
        is_cashback_coin: d[82] != 0,
        quote_mint: read_key(&d, 83),
        creator_fee_bps: read_u64(&d, 115),
        is_holder_reward: d[124] != 0,
        depth: d[141],
    })
}

/// Pump `Global`'s launch supply figures: (initial_real_token_reserves, token_total_supply).
pub fn read_global_supply(info: &AccountInfo) -> Result<(u64, u64)> {
    require_keys_eq!(info.key(), PUMP_GLOBAL, LaunchError::PumpAccountInvalid);
    let d = checked(info, &PUMP_PROGRAM_ID, 105, &GLOBAL_DISC)?;
    Ok((read_u64(&d, 89), read_u64(&d, 97)))
}

/// PumpSwap `Pool` fields a graduation record reads (offsets include the discriminator).
pub const POOL_MIN_LEN: usize = 8 + 1 + 2 + 32 * 6 + 8 + 32;
pub struct Pool {
    pub index: u16,
    pub creator: Pubkey,
    pub base_mint: Pubkey,
    pub quote_mint: Pubkey,
    pub coin_creator: Pubkey,
}
pub fn read_pool(info: &AccountInfo) -> Result<Pool> {
    let d = checked(info, &PUMP_AMM_PROGRAM_ID, POOL_MIN_LEN, &POOL_DISC)?;
    Ok(Pool {
        index: u16::from_le_bytes([d[9], d[10]]),
        creator: read_key(&d, 11),
        base_mint: read_key(&d, 43),
        quote_mint: read_key(&d, 75),
        coin_creator: read_key(&d, 211),
    })
}

/// True when a top-level instruction of this transaction, before the current one, is Pump's
/// `create_v2` creating `mint` (account 0) with `curve` (account 2). Read from the instructions
/// sysvar, so a curve created in an earlier transaction, or by a CPI, never matches.
pub fn created_in_this_tx(ix_sysvar: &AccountInfo, mint: &Pubkey, curve: &Pubkey) -> Result<bool> {
    let current = load_current_index_checked(ix_sysvar)? as usize;
    for i in 0..current {
        let ix = load_instruction_at_checked(i, ix_sysvar)?;
        if ix.program_id == PUMP_PROGRAM_ID && ix.data.len() >= 8 && ix.data[..8] == CREATE_V2 && ix.accounts.len() > 2
            && ix.accounts[0].pubkey == *mint && ix.accounts[2].pubkey == *curve {
            return Ok(true);
        }
    }
    Ok(false)
}
