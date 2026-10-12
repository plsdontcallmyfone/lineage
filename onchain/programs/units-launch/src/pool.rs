//! Agent pools (docs/plans/AGENT-POOLS.md): the agents launched on one repository share a vault.
//! Each member routes `pool_fee_bps` of its share of every fee crank into it; the routed `$LINE`
//! first funds the member's cross-holding purchases, then fills three buckets (payouts, buybacks,
//! burns) that only move at a settlement the pool keeper posts for a registry epoch. The program
//! pins what a settlement and the keeper can do: payouts reach members' compute vaults only, and a
//! buy is one CPI (Pump `buy_v3` or PumpSwap `buy_v2`, data built here) whose effect is checked by
//! balances: the vault may lose at most the allowed budget and the pool's own token account of the
//! target member's mint must gain the requested tokens. Off unless `LaunchConfig.features` has
//! `FEATURE_POOLS`.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::pump::{PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID};
use crate::{update_awake, AgentLaunch, LaunchConfig, LaunchError, AGENT_LAUNCH_SEED, BPS, COMPUTE_SEED, FEATURE_POOLS, LAUNCH_CONFIG_SEED, ROUTE_POOL, VENUE_PUMP};

pub const POOL_CONFIG_SEED: &[u8] = b"pool_config";
pub const POOL_SEED: &[u8] = b"pool";
pub const POOL_AUTH_SEED: &[u8] = b"pool_auth";
pub const POOL_MEMBER_SEED: &[u8] = b"pool_member";
pub const CROSS_SEED: &[u8] = b"cross";
pub const MAX_POOL_MEMBERS: usize = 16;
/// The most of an agent's share the pool slice may take, whatever the admin sets.
pub const MAX_POOL_FEE_BPS: u16 = 5_000;
pub const MAX_MILESTONES_PER_SETTLE: u8 = 16;

pub const BUY_BUYBACK: u8 = 1;
pub const BUY_BURN: u8 = 2;
pub const VENUE_CURVE: u8 = 0;
pub const VENUE_AMM: u8 = 1;
/// sha256("global:buy_v3")[..8] (Pump) and sha256("global:buy_v2")[..8] (PumpSwap).
pub const BUY_V3: [u8; 8] = [7, 5, 29, 196, 245, 23, 101, 80];
pub const BUY_V2: [u8; 8] = [184, 23, 238, 97, 103, 197, 211, 61];

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct PoolConfigArgs {
    /// Posts settlements and sends buys (a Core service key; never an agent key).
    pub keeper: Pubkey,
    /// Anyone may join a launched agent to the pool of its repository.
    pub auto_join: bool,
    pub paused: bool,
    pub max_members: u8,
    /// Of a member's share of each crank, into the pool vault.
    pub pool_fee_bps: u16,
    /// How routed `$LINE` divides into the buckets (sum 10,000).
    pub payout_bps: u16,
    pub buyback_bps: u16,
    pub burn_bps: u16,
    /// Of an author's part of a buyback budget, spent on the author's own token.
    pub author_buyback_bps: u16,
    /// Of the buyback bucket, released per verified generation of a settled epoch.
    pub buyback_per_gen_bps: u16,
    /// Of the burn bucket, released per milestone.
    pub burn_per_milestone_bps: u16,
    /// `$LINE` one member spends on one other member's token at join.
    pub cross_hold_quote: u64,
    /// Most `$LINE` one buy may spend.
    pub max_buy_quote: u64,
}
impl PoolConfigArgs {
    fn validate(&self) -> Result<()> {
        require!(self.keeper != Pubkey::default(), LaunchError::InvalidArgs);
        require!(self.max_members >= 2 && self.max_members as usize <= MAX_POOL_MEMBERS && self.pool_fee_bps <= MAX_POOL_FEE_BPS, LaunchError::InvalidArgs);
        require!(self.payout_bps as u64 + self.buyback_bps as u64 + self.burn_bps as u64 == BPS, LaunchError::InvalidArgs);
        require!(self.author_buyback_bps as u64 <= BPS && self.buyback_per_gen_bps as u64 <= BPS && self.burn_per_milestone_bps as u64 <= BPS,
            LaunchError::InvalidArgs);
        require!(self.max_buy_quote > 0, LaunchError::InvalidArgs);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct PoolConfig {
    pub keeper: Pubkey,
    pub auto_join: bool,
    pub paused: bool,
    pub max_members: u8,
    pub pool_fee_bps: u16,
    pub payout_bps: u16,
    pub buyback_bps: u16,
    pub burn_bps: u16,
    pub author_buyback_bps: u16,
    pub buyback_per_gen_bps: u16,
    pub burn_per_milestone_bps: u16,
    pub cross_hold_quote: u64,
    pub max_buy_quote: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub repo_id: [u8; 32],
    /// Member agent keys, in join order (a member's `index`).
    #[max_len(16)]
    pub members: Vec<Pubkey>,
    /// The pool authority's `$LINE` ATA.
    pub vault: Pubkey,
    pub created_at: i64,
    /// Routed and not yet allocated to a member: by purpose.
    pub bucket_payout: u64,
    pub bucket_buyback: u64,
    pub bucket_burn: u64,
    pub settled: bool,
    pub last_epoch: u64,
    pub gens: u64,
    pub milestones: u32,
    pub contributed: u64,
    pub paid: u64,
    pub bought: u64,
    pub burn_spent: u64,
    pub bump: u8,
    pub auth_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PoolMember {
    pub pool: Pubkey,
    pub agent: Pubkey,
    pub mint: Pubkey,
    pub index: u8,
    pub joined_at: i64,
    /// `$LINE` this member routed in.
    pub contributed: u64,
    /// Cross-holding purchases this member still owes, and the `$LINE` they still need.
    pub cross_pairs: u8,
    pub cross_due: u64,
    /// Funded from its own routed slice, not yet spent.
    pub cross_funded: u64,
    /// Allocated by settlements: to its compute vault, to buy its token and hold, to buy and burn.
    pub payout_due: u64,
    pub buyback_due: u64,
    pub burn_due: u64,
    pub paid: u64,
    /// `$LINE` spent buying this member's token (all kinds).
    pub bought_quote: u64,
    /// Tokens of this member's mint the pool holds and has burned.
    pub tokens_held: u64,
    pub tokens_burned: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CrossHolding {
    pub holder: Pubkey,
    pub target: Pubkey,
    pub quote_spent: u64,
    pub tokens: u64,
    pub bought_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PoolSettleArgs {
    /// A registry epoch already posted, newer than the pool's last settled one.
    pub epoch: u64,
    /// Verified generations by members in that epoch.
    pub gens: u16,
    /// Each member's share of the epoch's verified improvement, in member order (sum 10,000 when `gens` > 0, else all zero).
    pub weights: Vec<u16>,
    /// Milestones the repository newly crossed.
    pub milestones: u8,
    /// sha256 of Core's public settlement record.
    pub evidence: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct PoolBuyArgs {
    /// `VENUE_CURVE` (Pump `buy_v3`) or `VENUE_AMM` (PumpSwap `buy_v2`).
    pub venue: u8,
    /// Tokens to buy; the pool's token account must gain at least this many.
    pub token_amount: u64,
    /// Most `$LINE` this buy may spend (also bounded by the budget and `max_buy_quote`).
    pub max_quote: u64,
}

fn mul_bps(x: u64, bps: u64) -> u64 {
    (x as u128 * bps as u128 / BPS as u128) as u64
}

fn load_member<'info>(info: &'info AccountInfo<'info>, pool: &Pubkey, agent: &Pubkey) -> Result<Account<'info, PoolMember>> {
    let m: Account<PoolMember> = Account::try_from(info)?;
    let expected = Pubkey::create_program_address(&[POOL_MEMBER_SEED, agent.as_ref(), &[m.bump]], &crate::ID).map_err(|_| LaunchError::WrongPoolAccount)?;
    require!(info.key() == expected && m.agent == *agent && m.pool == *pool, LaunchError::WrongPoolAccount);
    Ok(m)
}

/// Every member's `PoolMember`, in member order, from the trailing accounts.
fn load_members<'info>(pool_key: &Pubkey, pool: &Pool, rest: &'info [AccountInfo<'info>]) -> Result<Vec<Account<'info, PoolMember>>> {
    require!(rest.len() == pool.members.len(), LaunchError::MissingRouteAccounts);
    let mut out = Vec::with_capacity(rest.len());
    for (info, agent) in rest.iter().zip(pool.members.iter()) {
        out.push(load_member(info, pool_key, agent)?);
    }
    Ok(out)
}

pub(crate) fn set_pool_config(ctx: Context<SetPoolConfig>, args: PoolConfigArgs) -> Result<()> {
    args.validate()?;
    let c = &mut ctx.accounts.pool_config;
    c.keeper = args.keeper;
    c.auto_join = args.auto_join;
    c.paused = args.paused;
    c.max_members = args.max_members;
    c.pool_fee_bps = args.pool_fee_bps;
    c.payout_bps = args.payout_bps;
    c.buyback_bps = args.buyback_bps;
    c.burn_bps = args.burn_bps;
    c.author_buyback_bps = args.author_buyback_bps;
    c.buyback_per_gen_bps = args.buyback_per_gen_bps;
    c.burn_per_milestone_bps = args.burn_per_milestone_bps;
    c.cross_hold_quote = args.cross_hold_quote;
    c.max_buy_quote = args.max_buy_quote;
    c.bump = ctx.bumps.pool_config;
    emit!(PoolConfigSet { args });
    Ok(())
}

pub(crate) fn join_pool<'info>(ctx: Context<'_, '_, 'info, 'info, JoinPool<'info>>) -> Result<()> {
    let lc = &ctx.accounts.launch_config;
    let cfg = &ctx.accounts.pool_config;
    require!(lc.features & FEATURE_POOLS != 0, LaunchError::FeatureOff);
    require!(!lc.paused && !cfg.paused, LaunchError::Paused);
    require!(cfg.auto_join || ctx.accounts.agent_record.owner == ctx.accounts.signer.key(), LaunchError::Unauthorized);
    let now = Clock::get()?.unix_timestamp;
    let pool_key = ctx.accounts.pool.key();
    let agent = ctx.accounts.agent_launch.agent;
    let pool = &mut ctx.accounts.pool;
    if pool.created_at == 0 {
        pool.repo_id = ctx.accounts.agent_launch.repo_id;
        pool.vault = ctx.accounts.pool_vault.key();
        pool.created_at = now.max(1);
        pool.bump = ctx.bumps.pool;
        pool.auth_bump = ctx.bumps.pool_auth;
    }
    require_keys_eq!(pool.vault, ctx.accounts.pool_vault.key(), LaunchError::WrongPoolAccount);
    require!(pool.members.len() < cfg.max_members as usize, LaunchError::PoolFull);
    // Cross-holdings: the newcomer owes one purchase per existing member, each of them one of the newcomer.
    let mut existing = load_members(&pool_key, pool, ctx.remaining_accounts)?;
    for m in existing.iter_mut() {
        m.cross_pairs = m.cross_pairs.checked_add(1).ok_or(LaunchError::InvalidArgs)?;
        m.cross_due = m.cross_due.checked_add(cfg.cross_hold_quote).ok_or(LaunchError::InvalidArgs)?;
        m.exit(&crate::ID)?;
    }
    let n = existing.len() as u64;
    let m = &mut ctx.accounts.pool_member;
    m.pool = pool_key;
    m.agent = agent;
    m.mint = ctx.accounts.agent_launch.mint;
    m.index = n as u8;
    m.joined_at = now;
    m.cross_pairs = n as u8;
    m.cross_due = cfg.cross_hold_quote.checked_mul(n).ok_or(LaunchError::InvalidArgs)?;
    m.bump = ctx.bumps.pool_member;
    pool.members.push(agent);
    ctx.accounts.agent_launch.routes |= ROUTE_POOL;
    emit!(PoolJoined { pool: pool_key, repo_id: pool.repo_id, agent, mint: m.mint, index: m.index, members: pool.members.len() as u8 });
    Ok(())
}

/// The pool slice of one crank. Trailing accounts: `PoolConfig`, the agent's `PoolMember`, its
/// `Pool`, the pool vault. Returns (amount, pool); `pay` moves the tokens. Nothing is routed while
/// the pool is paused or has fewer than two members.
pub(crate) fn route_slice<'info>(agent: &Pubkey, agent_share: u64, rest: &mut std::slice::Iter<'info, AccountInfo<'info>>,
    mut pay: impl FnMut(&AccountInfo<'info>, u64) -> Result<()>) -> Result<(u64, Pubkey)> {
    let (cfg_info, member_info, pool_info, vault_info) = match (rest.next(), rest.next(), rest.next(), rest.next()) {
        (Some(a), Some(b), Some(c), Some(d)) => (a, b, c, d),
        _ => return err!(LaunchError::MissingRouteAccounts),
    };
    let cfg: Account<PoolConfig> = Account::try_from(cfg_info)?;
    let cfg_key = Pubkey::create_program_address(&[POOL_CONFIG_SEED, &[cfg.bump]], &crate::ID).map_err(|_| LaunchError::WrongPoolAccount)?;
    require_keys_eq!(cfg_info.key(), cfg_key, LaunchError::WrongPoolAccount);
    let mut pool: Account<Pool> = Account::try_from(pool_info)?;
    let mut member = load_member(member_info, &pool_info.key(), agent)?;
    require_keys_eq!(vault_info.key(), pool.vault, LaunchError::WrongPoolAccount);
    if cfg.paused || pool.members.len() < 2 {
        return Ok((0, pool_info.key()));
    }
    let amount = mul_bps(agent_share, cfg.pool_fee_bps as u64);
    if amount > 0 {
        pay(vault_info, amount)?;
        member.contributed = member.contributed.saturating_add(amount);
        pool.contributed = pool.contributed.saturating_add(amount);
        let cross = amount.min(member.cross_due);
        member.cross_due -= cross;
        member.cross_funded += cross;
        let rest_amount = amount - cross;
        let payout = mul_bps(rest_amount, cfg.payout_bps as u64);
        let buyback = mul_bps(rest_amount, cfg.buyback_bps as u64);
        pool.bucket_payout += payout;
        pool.bucket_buyback += buyback;
        pool.bucket_burn += rest_amount - payout - buyback;
        member.exit(&crate::ID)?;
        pool.exit(&crate::ID)?;
    }
    Ok((amount, pool_info.key()))
}

pub(crate) fn pool_settle<'info>(ctx: Context<'_, '_, 'info, 'info, PoolSettle<'info>>, args: PoolSettleArgs) -> Result<()> {
    let lc = &ctx.accounts.launch_config;
    let cfg = &ctx.accounts.pool_config;
    require!(lc.features & FEATURE_POOLS != 0, LaunchError::FeatureOff);
    require!(!lc.paused && !cfg.paused, LaunchError::Paused);
    let rc = &ctx.accounts.registry_config;
    require!(rc.epochs_posted > 0 && args.epoch <= rc.last_epoch, LaunchError::PoolEpoch);
    let pool_key = ctx.accounts.pool.key();
    let pool = &mut ctx.accounts.pool;
    require!(!pool.settled || args.epoch > pool.last_epoch, LaunchError::PoolEpoch);
    let n = pool.members.len();
    require!(n >= 2 && args.weights.len() == n && args.milestones <= MAX_MILESTONES_PER_SETTLE, LaunchError::InvalidArgs);
    let total: u64 = args.weights.iter().map(|w| *w as u64).sum();
    require!(if args.gens > 0 { total == BPS } else { total == 0 }, LaunchError::PoolWeights);
    let mut members = load_members(&pool_key, pool, ctx.remaining_accounts)?;
    let (mut payout, mut buyback, mut burn) = (0u64, 0u64, 0u64);
    if args.gens > 0 {
        // (i) payouts: the whole bucket by weight.
        let p = pool.bucket_payout;
        // (ii) buybacks: each author's part buys its own token with author_buyback_bps, the others' with the rest, equally.
        let b = mul_bps(pool.bucket_buyback, (args.gens as u64 * cfg.buyback_per_gen_bps as u64).min(BPS));
        for i in 0..n {
            let w = args.weights[i] as u64;
            if w == 0 {
                continue;
            }
            let pi = mul_bps(p, w);
            members[i].payout_due += pi;
            payout += pi;
            let bi = mul_bps(b, w);
            let own = mul_bps(bi, cfg.author_buyback_bps as u64);
            let each = (bi - own) / (n as u64 - 1);
            members[i].buyback_due += own;
            buyback += own;
            for (j, m) in members.iter_mut().enumerate() {
                if j != i {
                    m.buyback_due += each;
                    buyback += each;
                }
            }
        }
    }
    if args.milestones > 0 {
        // (iii) milestone burn: equal parts for every member.
        let r = mul_bps(pool.bucket_burn, (args.milestones as u64 * cfg.burn_per_milestone_bps as u64).min(BPS));
        let each = r / n as u64;
        for m in members.iter_mut() {
            m.burn_due += each;
            burn += each;
        }
    }
    pool.bucket_payout -= payout;
    pool.bucket_buyback -= buyback;
    pool.bucket_burn -= burn;
    pool.settled = true;
    pool.last_epoch = args.epoch;
    pool.gens = pool.gens.saturating_add(args.gens as u64);
    pool.milestones = pool.milestones.saturating_add(args.milestones as u32);
    for m in members.iter() {
        m.exit(&crate::ID)?;
    }
    emit!(PoolSettled { pool: pool_key, epoch: args.epoch, gens: args.gens, milestones: args.milestones, weights: args.weights, payout, buyback, burn,
        evidence: args.evidence });
    Ok(())
}

/// Anyone: a member's allocated payout into its compute vault.
pub(crate) fn pool_pay(ctx: Context<PoolPay>) -> Result<()> {
    let lc = &ctx.accounts.launch_config;
    require!(!lc.paused, LaunchError::Paused);
    let amount = ctx.accounts.member.payout_due;
    require!(amount > 0, LaunchError::NothingToClaim);
    let pool = &ctx.accounts.pool;
    let seeds: &[&[u8]] = &[POOL_AUTH_SEED, pool.repo_id.as_ref(), &[pool.auth_bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(ctx.accounts.line_token_program.to_account_info(), TransferChecked {
            from: ctx.accounts.pool_vault.to_account_info(),
            mint: ctx.accounts.line_mint.to_account_info(),
            to: ctx.accounts.compute_vault.to_account_info(),
            authority: ctx.accounts.pool_auth.to_account_info(),
        }, &[seeds]),
        amount,
        ctx.accounts.line_mint.decimals,
    )?;
    ctx.accounts.compute_vault.reload()?;
    let m = &mut ctx.accounts.member;
    m.payout_due = 0;
    m.paid = m.paid.saturating_add(amount);
    ctx.accounts.pool.paid = ctx.accounts.pool.paid.saturating_add(amount);
    let balance = ctx.accounts.compute_vault.amount;
    update_awake(&mut ctx.accounts.agent_launch, balance, lc);
    emit!(PoolPaid { pool: ctx.accounts.pool.key(), agent: m.agent, amount, balance, awake: ctx.accounts.agent_launch.awake });
    Ok(())
}

/// One CPI buy for the pool authority, then the balance checks. Returns (`$LINE` spent, tokens gained).
#[allow(clippy::too_many_arguments)]
fn execute_buy<'info>(args: &PoolBuyArgs, cap: u64, pool: &Pool, pool_auth: &AccountInfo<'info>, pool_vault: &mut InterfaceAccount<'info, TokenAccount>,
    pool_token: &mut InterfaceAccount<'info, TokenAccount>, venue_program: &AccountInfo<'info>, rest: &[AccountInfo<'info>]) -> Result<(u64, u64)> {
    require!(cap > 0 && args.token_amount > 0, LaunchError::PoolBudget);
    let mut data = Vec::with_capacity(25);
    let program = match args.venue {
        VENUE_CURVE => {
            data.extend_from_slice(&BUY_V3);
            data.extend_from_slice(&args.token_amount.to_le_bytes());
            data.extend_from_slice(&cap.to_le_bytes());
            data.push(0);
            PUMP_PROGRAM_ID
        }
        VENUE_AMM => {
            data.extend_from_slice(&BUY_V2);
            data.extend_from_slice(&args.token_amount.to_le_bytes());
            data.extend_from_slice(&cap.to_le_bytes());
            PUMP_AMM_PROGRAM_ID
        }
        _ => return err!(LaunchError::InvalidArgs),
    };
    require_keys_eq!(venue_program.key(), program, LaunchError::WrongVenue);
    // Only the pool authority signs inside the call, whatever else signed the transaction.
    let accounts: Vec<AccountMeta> = rest.iter().map(|a| AccountMeta { pubkey: a.key(), is_signer: a.key() == pool_auth.key(), is_writable: a.is_writable }).collect();
    let mut infos = rest.to_vec();
    infos.push(venue_program.clone());
    let (quote_before, tokens_before) = (pool_vault.amount, pool_token.amount);
    let seeds: &[&[u8]] = &[POOL_AUTH_SEED, pool.repo_id.as_ref(), &[pool.auth_bump]];
    invoke_signed(&Instruction { program_id: program, accounts, data }, &infos, &[seeds])?;
    pool_vault.reload()?;
    pool_token.reload()?;
    let spent = quote_before.checked_sub(pool_vault.amount).ok_or(LaunchError::PoolBudget)?;
    let got = pool_token.amount.checked_sub(tokens_before).ok_or(LaunchError::PoolBuyShort)?;
    require!(spent > 0 && spent <= cap, LaunchError::PoolBudget);
    require!(got >= args.token_amount, LaunchError::PoolBuyShort);
    Ok((spent, got))
}

/// Keeper: spends a member's allocated buyback (tokens held by the pool) or burn (tokens burned) budget on its token.
pub(crate) fn pool_buy<'info>(ctx: Context<'_, '_, 'info, 'info, PoolBuy<'info>>, kind: u8, args: PoolBuyArgs) -> Result<()> {
    let lc = &ctx.accounts.launch_config;
    let cfg = &ctx.accounts.pool_config;
    require!(lc.features & FEATURE_POOLS != 0, LaunchError::FeatureOff);
    require!(!lc.paused && !cfg.paused, LaunchError::Paused);
    let due = match kind {
        BUY_BUYBACK => ctx.accounts.target.buyback_due,
        BUY_BURN => ctx.accounts.target.burn_due,
        _ => return err!(LaunchError::InvalidArgs),
    };
    let cap = due.min(args.max_quote).min(cfg.max_buy_quote);
    let (spent, got) = execute_buy(&args, cap, &ctx.accounts.pool, &ctx.accounts.pool_auth.to_account_info(), &mut ctx.accounts.pool_vault,
        &mut ctx.accounts.pool_token, &ctx.accounts.venue_program.to_account_info(), ctx.remaining_accounts)?;
    let pool_key = ctx.accounts.pool.key();
    let t = &mut ctx.accounts.target;
    t.bought_quote = t.bought_quote.saturating_add(spent);
    if kind == BUY_BURN {
        t.burn_due -= spent;
        let pool = &ctx.accounts.pool;
        let seeds: &[&[u8]] = &[POOL_AUTH_SEED, pool.repo_id.as_ref(), &[pool.auth_bump]];
        token_interface::burn(
            CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), Burn {
                mint: ctx.accounts.target_mint.to_account_info(),
                from: ctx.accounts.pool_token.to_account_info(),
                authority: ctx.accounts.pool_auth.to_account_info(),
            }, &[seeds]),
            got,
        )?;
        t.tokens_burned = t.tokens_burned.saturating_add(got);
        ctx.accounts.pool.burn_spent = ctx.accounts.pool.burn_spent.saturating_add(spent);
    } else {
        t.buyback_due -= spent;
        t.tokens_held = t.tokens_held.saturating_add(got);
        ctx.accounts.pool.bought = ctx.accounts.pool.bought.saturating_add(spent);
    }
    emit!(PoolBought { pool: pool_key, kind, holder: Pubkey::default(), target: t.agent, mint: t.mint, venue: args.venue, quote_spent: spent, tokens: got,
        burned: kind == BUY_BURN });
    Ok(())
}

/// Keeper: one member's cross-holding purchase of another member's token, once per ordered pair,
/// from the `$LINE` the holder's own routed slice funded.
pub(crate) fn pool_cross_buy<'info>(ctx: Context<'_, '_, 'info, 'info, PoolCrossBuy<'info>>, args: PoolBuyArgs) -> Result<()> {
    let lc = &ctx.accounts.launch_config;
    let cfg = &ctx.accounts.pool_config;
    require!(lc.features & FEATURE_POOLS != 0, LaunchError::FeatureOff);
    require!(!lc.paused && !cfg.paused, LaunchError::Paused);
    let h = &ctx.accounts.holder;
    require!(h.agent != ctx.accounts.target.agent && h.cross_pairs > 0, LaunchError::PoolBudget);
    // A purchase waits until it is fully funded, unless nothing more is owed.
    require!(h.cross_funded >= cfg.cross_hold_quote || h.cross_due == 0, LaunchError::PoolBudget);
    let cap = h.cross_funded.min(cfg.cross_hold_quote).min(args.max_quote).min(cfg.max_buy_quote);
    let (spent, got) = execute_buy(&args, cap, &ctx.accounts.pool, &ctx.accounts.pool_auth.to_account_info(), &mut ctx.accounts.pool_vault,
        &mut ctx.accounts.pool_token, &ctx.accounts.venue_program.to_account_info(), ctx.remaining_accounts)?;
    let now = Clock::get()?.unix_timestamp;
    let h = &mut ctx.accounts.holder;
    h.cross_funded -= spent;
    h.cross_pairs -= 1;
    if h.cross_pairs == 0 && h.cross_due == 0 {
        // What its purchases did not use goes to the buyback bucket.
        ctx.accounts.pool.bucket_buyback += h.cross_funded;
        h.cross_funded = 0;
    }
    let t = &mut ctx.accounts.target;
    t.bought_quote = t.bought_quote.saturating_add(spent);
    t.tokens_held = t.tokens_held.saturating_add(got);
    ctx.accounts.pool.bought = ctx.accounts.pool.bought.saturating_add(spent);
    let c = &mut ctx.accounts.cross;
    c.holder = h.agent;
    c.target = t.agent;
    c.quote_spent = spent;
    c.tokens = got;
    c.bought_at = now;
    emit!(PoolBought { pool: ctx.accounts.pool.key(), kind: 0, holder: h.agent, target: t.agent, mint: t.mint, venue: args.venue, quote_spent: spent,
        tokens: got, burned: false });
    Ok(())
}

// ---------- accounts ----------

#[derive(Accounts)]
pub struct SetPoolConfig<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = admin @ LaunchError::Unauthorized)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init_if_needed, payer = admin, space = 8 + PoolConfig::INIT_SPACE, seeds = [POOL_CONFIG_SEED], bump)]
    pub pool_config: Box<Account<'info, PoolConfig>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinPool<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = line_mint)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(seeds = [POOL_CONFIG_SEED], bump = pool_config.bump)]
    pub pool_config: Box<Account<'info, PoolConfig>>,
    /// The agent's registry owner, or anyone while `auto_join` is on. Pays the rent.
    #[account(mut)]
    pub signer: Signer<'info>,
    #[account(mut, seeds = [AGENT_LAUNCH_SEED, agent_launch.mint.as_ref()], bump = agent_launch.bump,
        constraint = agent_launch.venue == VENUE_PUMP @ LaunchError::WrongPhase)]
    pub agent_launch: Box<Account<'info, AgentLaunch>>,
    #[account(seeds = [units_registry::AGENT_SEED, agent_launch.agent.as_ref()], bump = agent_record.bump, seeds::program = units_registry::ID)]
    pub agent_record: Box<Account<'info, units_registry::Agent>>,
    #[account(init_if_needed, payer = signer, space = 8 + Pool::INIT_SPACE, seeds = [POOL_SEED, agent_launch.repo_id.as_ref()], bump)]
    pub pool: Box<Account<'info, Pool>>,
    #[account(init, payer = signer, space = 8 + PoolMember::INIT_SPACE, seeds = [POOL_MEMBER_SEED, agent_launch.agent.as_ref()], bump)]
    pub pool_member: Box<Account<'info, PoolMember>>,
    /// CHECK: PDA that owns the pool's token accounts and signs its buys.
    #[account(seeds = [POOL_AUTH_SEED, agent_launch.repo_id.as_ref()], bump)]
    pub pool_auth: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = signer, associated_token::mint = line_mint, associated_token::authority = pool_auth,
        associated_token::token_program = line_token_program)]
    pub pool_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = line_token_program)]
    pub line_mint: Box<InterfaceAccount<'info, Mint>>,
    pub line_token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PoolSettle<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(seeds = [POOL_CONFIG_SEED], bump = pool_config.bump, has_one = keeper @ LaunchError::Unauthorized)]
    pub pool_config: Box<Account<'info, PoolConfig>>,
    pub keeper: Signer<'info>,
    #[account(seeds = [units_registry::CONFIG_SEED], bump = registry_config.bump, seeds::program = units_registry::ID)]
    pub registry_config: Box<Account<'info, units_registry::Config>>,
    #[account(mut, seeds = [POOL_SEED, pool.repo_id.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
}

#[derive(Accounts)]
pub struct PoolPay<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = line_mint)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(mut, seeds = [POOL_SEED, pool.repo_id.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: PDA signer of the pool vault.
    #[account(seeds = [POOL_AUTH_SEED, pool.repo_id.as_ref()], bump = pool.auth_bump)]
    pub pool_auth: UncheckedAccount<'info>,
    #[account(mut, address = pool.vault @ LaunchError::WrongPoolAccount)]
    pub pool_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [POOL_MEMBER_SEED, member.agent.as_ref()], bump = member.bump, constraint = member.pool == pool.key() @ LaunchError::WrongPoolAccount)]
    pub member: Box<Account<'info, PoolMember>>,
    #[account(mut, seeds = [AGENT_LAUNCH_SEED, member.mint.as_ref()], bump = agent_launch.bump)]
    pub agent_launch: Box<Account<'info, AgentLaunch>>,
    #[account(mut, seeds = [COMPUTE_SEED, member.agent.as_ref()], bump = agent_launch.compute_bump)]
    pub compute_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = line_token_program)]
    pub line_mint: Box<InterfaceAccount<'info, Mint>>,
    pub line_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct PoolBuy<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(seeds = [POOL_CONFIG_SEED], bump = pool_config.bump, has_one = keeper @ LaunchError::Unauthorized)]
    pub pool_config: Box<Account<'info, PoolConfig>>,
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool.repo_id.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: PDA, the buyer inside the venue call.
    #[account(mut, seeds = [POOL_AUTH_SEED, pool.repo_id.as_ref()], bump = pool.auth_bump)]
    pub pool_auth: UncheckedAccount<'info>,
    #[account(mut, address = pool.vault @ LaunchError::WrongPoolAccount)]
    pub pool_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [POOL_MEMBER_SEED, target.agent.as_ref()], bump = target.bump, constraint = target.pool == pool.key() @ LaunchError::WrongPoolAccount)]
    pub target: Box<Account<'info, PoolMember>>,
    #[account(mut, address = target.mint @ LaunchError::WrongPoolAccount, mint::token_program = token_program)]
    pub target_mint: Box<InterfaceAccount<'info, Mint>>,
    /// The pool authority's token account of the target's mint.
    #[account(mut, token::mint = target_mint, token::authority = pool_auth, token::token_program = token_program)]
    pub pool_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: must be Pump or PumpSwap, by `args.venue` (checked in `execute_buy`).
    pub venue_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct PoolCrossBuy<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(seeds = [POOL_CONFIG_SEED], bump = pool_config.bump, has_one = keeper @ LaunchError::Unauthorized)]
    pub pool_config: Box<Account<'info, PoolConfig>>,
    #[account(mut)]
    pub keeper: Signer<'info>,
    #[account(mut, seeds = [POOL_SEED, pool.repo_id.as_ref()], bump = pool.bump)]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: PDA, the buyer inside the venue call.
    #[account(mut, seeds = [POOL_AUTH_SEED, pool.repo_id.as_ref()], bump = pool.auth_bump)]
    pub pool_auth: UncheckedAccount<'info>,
    #[account(mut, address = pool.vault @ LaunchError::WrongPoolAccount)]
    pub pool_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [POOL_MEMBER_SEED, holder.agent.as_ref()], bump = holder.bump, constraint = holder.pool == pool.key() @ LaunchError::WrongPoolAccount)]
    pub holder: Box<Account<'info, PoolMember>>,
    #[account(mut, seeds = [POOL_MEMBER_SEED, target.agent.as_ref()], bump = target.bump, constraint = target.pool == pool.key() @ LaunchError::WrongPoolAccount)]
    pub target: Box<Account<'info, PoolMember>>,
    #[account(init, payer = keeper, space = 8 + CrossHolding::INIT_SPACE, seeds = [CROSS_SEED, holder.agent.as_ref(), target.agent.as_ref()], bump)]
    pub cross: Box<Account<'info, CrossHolding>>,
    #[account(address = target.mint @ LaunchError::WrongPoolAccount, mint::token_program = token_program)]
    pub target_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = target_mint, token::authority = pool_auth, token::token_program = token_program)]
    pub pool_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    /// CHECK: must be Pump or PumpSwap, by `args.venue` (checked in `execute_buy`).
    pub venue_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

// ---------- events ----------

#[event]
pub struct PoolConfigSet {
    pub args: PoolConfigArgs,
}
#[event]
pub struct PoolJoined {
    pub pool: Pubkey,
    pub repo_id: [u8; 32],
    pub agent: Pubkey,
    pub mint: Pubkey,
    pub index: u8,
    pub members: u8,
}
#[event]
pub struct PoolSettled {
    pub pool: Pubkey,
    pub epoch: u64,
    pub gens: u16,
    pub milestones: u8,
    pub weights: Vec<u16>,
    pub payout: u64,
    pub buyback: u64,
    pub burn: u64,
    pub evidence: [u8; 32],
}
#[event]
pub struct PoolPaid {
    pub pool: Pubkey,
    pub agent: Pubkey,
    pub amount: u64,
    pub balance: u64,
    pub awake: bool,
}
#[event]
pub struct PoolBought {
    pub pool: Pubkey,
    /// 0 cross-holding, 1 buyback (held), 2 milestone burn.
    pub kind: u8,
    /// The member whose slice funded a cross-holding (the default key otherwise).
    pub holder: Pubkey,
    pub target: Pubkey,
    pub mint: Pubkey,
    pub venue: u8,
    pub quote_spent: u64,
    pub tokens: u64,
    pub burned: bool,
}
