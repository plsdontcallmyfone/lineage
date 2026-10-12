//! GitHub fee routing and claims (docs/plans/GITHUB-FEE-CLAIMS.md). An agent's registry owner routes
//! `bps` of the agent's share of every fee crank to a GitHub account, named by its numeric id. The
//! slice accrues in a token account only `claim_github_fees` can move, and a claim pays only the
//! wallet named by an attestation signed by `ClaimConfig.attestor` (Core, after it checked the
//! GitHub proof), carried as an Ed25519 precompile instruction of the same transaction. The message
//! binds program, GitHub id, wallet, amount ceiling, the escrow's `claim_seq` and an expiry, so an
//! attestation pays one wallet once. Off unless `LaunchConfig.features` has `FEATURE_GITHUB_FEES`.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::sysvar::instructions::{load_current_index_checked, load_instruction_at_checked};
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{AgentLaunch, LaunchConfig, LaunchError, AGENT_LAUNCH_SEED, AUTHORITY_SEED, BPS, FEATURE_GITHUB_FEES, LAUNCH_CONFIG_SEED, ROUTE_GITHUB, VENUE_PUMP};

pub const CLAIM_CONFIG_SEED: &[u8] = b"claim_config";
pub const FEE_ROUTE_SEED: &[u8] = b"fee_route";
pub const GH_ESCROW_SEED: &[u8] = b"gh_escrow";
pub const GH_VAULT_SEED: &[u8] = b"gh_vault";
/// First bytes of every attestation message.
pub const CLAIM_DOMAIN: &[u8] = b"units-github-claim-v1";
/// The most of an agent's share a route may take, whatever the admin sets.
pub const MAX_ROUTE_BPS: u16 = 5_000;
pub const ED25519_PROGRAM_ID: Pubkey = pubkey!("Ed25519SigVerify111111111111111111111111111");

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ClaimConfigArgs {
    /// Signs claim attestations (Core, after it verified the GitHub proof).
    pub attestor: Pubkey,
    pub min_bps: u16,
    pub max_bps: u16,
    /// Seconds between a route change and the moment it may be applied.
    pub change_delay_s: i64,
    /// Seconds between an attestation naming a new wallet and the moment that wallet may claim.
    pub rebind_delay_s: i64,
    /// Longest life of an attestation.
    pub max_attestation_ttl_s: i64,
    pub paused: bool,
}
impl ClaimConfigArgs {
    fn validate(&self) -> Result<()> {
        require!(self.attestor != Pubkey::default(), LaunchError::InvalidArgs);
        require!(self.min_bps >= 1 && self.min_bps <= self.max_bps && self.max_bps <= MAX_ROUTE_BPS, LaunchError::InvalidArgs);
        require!(self.change_delay_s >= 0 && self.rebind_delay_s >= 0 && self.max_attestation_ttl_s > 0, LaunchError::InvalidArgs);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct ClaimConfig {
    pub attestor: Pubkey,
    pub min_bps: u16,
    pub max_bps: u16,
    pub change_delay_s: i64,
    pub rebind_delay_s: i64,
    pub max_attestation_ttl_s: i64,
    pub paused: bool,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct FeeRoute {
    pub agent: Pubkey,
    /// GitHub's numeric account id (0 = no route yet).
    pub github_id: u64,
    pub bps: u16,
    pub set_at: i64,
    pub pending_github_id: u64,
    pub pending_bps: u16,
    /// 0 = nothing pending.
    pub pending_effective_at: i64,
    /// Routed to the current id.
    pub accrued: u64,
    /// Routed to every id this agent ever named.
    pub accrued_total: u64,
    pub changes: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ClaimEscrow {
    pub github_id: u64,
    /// Pinned by the first claim.
    pub wallet: Pubkey,
    pub pending_wallet: Pubkey,
    pub pending_effective_at: i64,
    pub accrued: u64,
    pub claimed: u64,
    /// Every used attestation adds one.
    pub claim_seq: u64,
    pub bump: u8,
    pub vault_bump: u8,
}

/// The bytes the attestor signs for one claim.
pub fn claim_message(github_id: u64, wallet: &Pubkey, ceiling: u64, claim_seq: u64, expires_at: i64) -> Vec<u8> {
    let mut m = Vec::with_capacity(CLAIM_DOMAIN.len() + 32 + 8 + 32 + 8 + 8 + 8);
    m.extend_from_slice(CLAIM_DOMAIN);
    m.extend_from_slice(crate::ID.as_ref());
    m.extend_from_slice(&github_id.to_le_bytes());
    m.extend_from_slice(wallet.as_ref());
    m.extend_from_slice(&ceiling.to_le_bytes());
    m.extend_from_slice(&claim_seq.to_le_bytes());
    m.extend_from_slice(&expires_at.to_le_bytes());
    m
}

/// True when an earlier top-level instruction of this transaction is the Ed25519 precompile
/// verifying exactly one signature by `attestor` over exactly `msg`, with key, signature and message
/// all inside that instruction's own data (an offset into another instruction is refused: the
/// precompile would verify bytes this check never saw).
fn attested(ix_sysvar: &AccountInfo, attestor: &Pubkey, msg: &[u8]) -> Result<bool> {
    let current = load_current_index_checked(ix_sysvar)? as usize;
    for i in 0..current {
        let ix = load_instruction_at_checked(i, ix_sysvar)?;
        let d = &ix.data;
        if ix.program_id != ED25519_PROGRAM_ID || d.len() < 16 || d[0] != 1 {
            continue;
        }
        let u = |o: usize| u16::from_le_bytes([d[o], d[o + 1]]) as usize;
        let (sig_off, sig_ix, key_off, key_ix, msg_off, msg_len, msg_ix) = (u(2), u(4), u(6), u(8), u(10), u(12), u(14));
        if sig_ix != u16::MAX as usize || key_ix != u16::MAX as usize || msg_ix != u16::MAX as usize {
            continue;
        }
        if sig_off + 64 > d.len() || key_off + 32 > d.len() || msg_off + msg_len > d.len() {
            continue;
        }
        if d[key_off..key_off + 32] == attestor.to_bytes() && d[msg_off..msg_off + msg_len] == *msg {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(crate) fn set_claim_config(ctx: Context<SetClaimConfig>, args: ClaimConfigArgs) -> Result<()> {
    args.validate()?;
    let c = &mut ctx.accounts.claim_config;
    c.attestor = args.attestor;
    c.min_bps = args.min_bps;
    c.max_bps = args.max_bps;
    c.change_delay_s = args.change_delay_s;
    c.rebind_delay_s = args.rebind_delay_s;
    c.max_attestation_ttl_s = args.max_attestation_ttl_s;
    c.paused = args.paused;
    c.bump = ctx.bumps.claim_config;
    emit!(ClaimConfigSet { args });
    Ok(())
}

pub(crate) fn set_fee_route(ctx: Context<SetFeeRoute>, github_id: u64, bps: u16) -> Result<()> {
    let lc = &ctx.accounts.launch_config;
    let cfg = &ctx.accounts.claim_config;
    require!(lc.features & FEATURE_GITHUB_FEES != 0, LaunchError::FeatureOff);
    require!(!lc.paused && !cfg.paused, LaunchError::Paused);
    require_keys_eq!(ctx.accounts.agent_record.owner, ctx.accounts.owner.key(), LaunchError::Unauthorized);
    require!(github_id != 0 && bps >= cfg.min_bps && bps <= cfg.max_bps, LaunchError::RouteBounds);
    let now = Clock::get()?.unix_timestamp;
    let agent = ctx.accounts.agent_launch.agent;
    let e = &mut ctx.accounts.claim_escrow;
    if e.github_id == 0 {
        e.github_id = github_id;
        e.bump = ctx.bumps.claim_escrow;
        e.vault_bump = ctx.bumps.escrow_vault;
    }
    let r = &mut ctx.accounts.fee_route;
    if r.github_id == 0 {
        r.agent = agent;
        r.github_id = github_id;
        r.bps = bps;
        r.set_at = now;
        r.bump = ctx.bumps.fee_route;
        ctx.accounts.agent_launch.routes |= ROUTE_GITHUB;
        emit!(FeeRouteSet { agent, github_id, bps, previous_github_id: 0 });
    } else {
        r.pending_github_id = github_id;
        r.pending_bps = bps;
        r.pending_effective_at = now.checked_add(cfg.change_delay_s).ok_or(LaunchError::InvalidArgs)?.max(1);
        emit!(FeeRoutePending { agent, github_id, bps, effective_at: r.pending_effective_at });
    }
    Ok(())
}

pub(crate) fn apply_fee_route(ctx: Context<ApplyFeeRoute>) -> Result<()> {
    require!(!ctx.accounts.claim_config.paused, LaunchError::Paused);
    let now = Clock::get()?.unix_timestamp;
    let r = &mut ctx.accounts.fee_route;
    require!(r.pending_effective_at != 0, LaunchError::NoPendingRoute);
    require!(now >= r.pending_effective_at, LaunchError::RouteTimelock);
    let previous = r.github_id;
    if r.pending_github_id != previous {
        r.accrued = 0;
    }
    r.github_id = r.pending_github_id;
    r.bps = r.pending_bps;
    r.set_at = now;
    r.pending_github_id = 0;
    r.pending_bps = 0;
    r.pending_effective_at = 0;
    r.changes = r.changes.saturating_add(1);
    emit!(FeeRouteSet { agent: r.agent, github_id: r.github_id, bps: r.bps, previous_github_id: previous });
    Ok(())
}

/// The GitHub slice of one crank. Trailing accounts: the agent's `FeeRoute`, the `ClaimEscrow` of
/// its current id, that escrow's vault. Returns (amount, github id); `pay` moves the tokens.
pub(crate) fn route_slice<'info>(agent: &Pubkey, agent_share: u64, rest: &mut std::slice::Iter<'info, AccountInfo<'info>>,
    mut pay: impl FnMut(&AccountInfo<'info>, u64) -> Result<()>) -> Result<(u64, u64)> {
    let (route_info, escrow_info, vault_info) = match (rest.next(), rest.next(), rest.next()) {
        (Some(a), Some(b), Some(c)) => (a, b, c),
        _ => return err!(LaunchError::MissingRouteAccounts),
    };
    let mut route: Account<FeeRoute> = Account::try_from(route_info)?;
    let expected = Pubkey::create_program_address(&[FEE_ROUTE_SEED, agent.as_ref(), &[route.bump]], &crate::ID).map_err(|_| LaunchError::WrongRouteAccount)?;
    require!(route_info.key() == expected && route.agent == *agent && route.github_id != 0, LaunchError::WrongRouteAccount);
    let mut escrow: Account<ClaimEscrow> = Account::try_from(escrow_info)?;
    let id = route.github_id.to_le_bytes();
    let escrow_key = Pubkey::create_program_address(&[GH_ESCROW_SEED, &id, &[escrow.bump]], &crate::ID).map_err(|_| LaunchError::WrongRouteAccount)?;
    let vault_key = Pubkey::create_program_address(&[GH_VAULT_SEED, &id, &[escrow.vault_bump]], &crate::ID).map_err(|_| LaunchError::WrongRouteAccount)?;
    require!(escrow_info.key() == escrow_key && escrow.github_id == route.github_id && vault_info.key() == vault_key, LaunchError::WrongRouteAccount);
    let amount = (agent_share as u128 * route.bps as u128 / BPS as u128) as u64;
    if amount > 0 {
        pay(vault_info, amount)?;
        route.accrued = route.accrued.saturating_add(amount);
        route.accrued_total = route.accrued_total.saturating_add(amount);
        escrow.accrued = escrow.accrued.saturating_add(amount);
        route.exit(&crate::ID)?;
        escrow.exit(&crate::ID)?;
    }
    Ok((amount, route.github_id))
}

pub(crate) fn claim_github_fees(ctx: Context<ClaimGithubFees>, ceiling: u64, expires_at: i64) -> Result<()> {
    let cfg = &ctx.accounts.claim_config;
    require!(!cfg.paused && !ctx.accounts.launch_config.paused, LaunchError::Paused);
    let now = Clock::get()?.unix_timestamp;
    require!(expires_at >= now, LaunchError::AttestationExpired);
    require!(expires_at - now <= cfg.max_attestation_ttl_s, LaunchError::AttestationTtl);
    let wallet = ctx.accounts.wallet.key();
    let e = &mut ctx.accounts.claim_escrow;
    let msg = claim_message(e.github_id, &wallet, ceiling, e.claim_seq, expires_at);
    require!(attested(&ctx.accounts.instructions.to_account_info(), &cfg.attestor, &msg)?, LaunchError::BadAttestation);
    e.claim_seq = e.claim_seq.checked_add(1).ok_or(LaunchError::InvalidArgs)?;
    if e.wallet == Pubkey::default() {
        e.wallet = wallet;
    } else if e.wallet != wallet {
        if e.pending_wallet == wallet {
            require!(now >= e.pending_effective_at, LaunchError::RebindPending);
            e.wallet = wallet;
        } else {
            e.pending_wallet = wallet;
            e.pending_effective_at = now.checked_add(cfg.rebind_delay_s).ok_or(LaunchError::InvalidArgs)?;
            emit!(ClaimWalletPending { github_id: e.github_id, wallet: e.wallet, pending_wallet: wallet, effective_at: e.pending_effective_at });
            return Ok(());
        }
    }
    // A claim by the pinned wallet (or a completed rebind) cancels any pending rebind.
    e.pending_wallet = Pubkey::default();
    e.pending_effective_at = 0;
    let amount = ceiling.min(ctx.accounts.escrow_vault.amount);
    require!(amount > 0, LaunchError::NothingToClaim);
    let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[ctx.accounts.launch_config.authority_bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(ctx.accounts.line_token_program.to_account_info(), TransferChecked {
            from: ctx.accounts.escrow_vault.to_account_info(),
            mint: ctx.accounts.line_mint.to_account_info(),
            to: ctx.accounts.wallet_token.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        }, &[seeds]),
        amount,
        ctx.accounts.line_mint.decimals,
    )?;
    e.claimed = e.claimed.saturating_add(amount);
    emit!(GithubFeesClaimed { github_id: e.github_id, wallet, amount, claim_seq: e.claim_seq, claimed: e.claimed });
    Ok(())
}

// ---------- accounts ----------

#[derive(Accounts)]
pub struct SetClaimConfig<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = admin @ LaunchError::Unauthorized)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init_if_needed, payer = admin, space = 8 + ClaimConfig::INIT_SPACE, seeds = [CLAIM_CONFIG_SEED], bump)]
    pub claim_config: Box<Account<'info, ClaimConfig>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(github_id: u64)]
pub struct SetFeeRoute<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = line_mint)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(seeds = [CLAIM_CONFIG_SEED], bump = claim_config.bump)]
    pub claim_config: Box<Account<'info, ClaimConfig>>,
    /// The agent's current registry owner (the launcher until an owner transfer).
    #[account(mut)]
    pub owner: Signer<'info>,
    #[account(mut, seeds = [AGENT_LAUNCH_SEED, agent_launch.mint.as_ref()], bump = agent_launch.bump,
        constraint = agent_launch.venue == VENUE_PUMP @ LaunchError::WrongPhase)]
    pub agent_launch: Box<Account<'info, AgentLaunch>>,
    #[account(seeds = [units_registry::AGENT_SEED, agent_launch.agent.as_ref()], bump = agent_record.bump, seeds::program = units_registry::ID)]
    pub agent_record: Box<Account<'info, units_registry::Agent>>,
    #[account(init_if_needed, payer = owner, space = 8 + FeeRoute::INIT_SPACE, seeds = [FEE_ROUTE_SEED, agent_launch.agent.as_ref()], bump)]
    pub fee_route: Box<Account<'info, FeeRoute>>,
    #[account(init_if_needed, payer = owner, space = 8 + ClaimEscrow::INIT_SPACE, seeds = [GH_ESCROW_SEED, &github_id.to_le_bytes()], bump)]
    pub claim_escrow: Box<Account<'info, ClaimEscrow>>,
    #[account(init_if_needed, payer = owner, seeds = [GH_VAULT_SEED, &github_id.to_le_bytes()], bump, token::mint = line_mint, token::authority = authority,
        token::token_program = line_token_program)]
    pub escrow_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: PDA that owns every escrow vault.
    #[account(seeds = [AUTHORITY_SEED], bump = launch_config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mint::token_program = line_token_program)]
    pub line_mint: Box<InterfaceAccount<'info, Mint>>,
    pub line_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ApplyFeeRoute<'info> {
    #[account(seeds = [CLAIM_CONFIG_SEED], bump = claim_config.bump)]
    pub claim_config: Box<Account<'info, ClaimConfig>>,
    #[account(mut, seeds = [FEE_ROUTE_SEED, fee_route.agent.as_ref()], bump = fee_route.bump)]
    pub fee_route: Box<Account<'info, FeeRoute>>,
}

#[derive(Accounts)]
pub struct ClaimGithubFees<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = line_mint)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(seeds = [CLAIM_CONFIG_SEED], bump = claim_config.bump)]
    pub claim_config: Box<Account<'info, ClaimConfig>>,
    /// The wallet the attestation names.
    pub wallet: Signer<'info>,
    #[account(mut, seeds = [GH_ESCROW_SEED, &claim_escrow.github_id.to_le_bytes()], bump = claim_escrow.bump)]
    pub claim_escrow: Box<Account<'info, ClaimEscrow>>,
    #[account(mut, seeds = [GH_VAULT_SEED, &claim_escrow.github_id.to_le_bytes()], bump = claim_escrow.vault_bump)]
    pub escrow_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = line_mint, token::authority = wallet, token::token_program = line_token_program)]
    pub wallet_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: PDA signer of the escrow vault.
    #[account(seeds = [AUTHORITY_SEED], bump = launch_config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mint::token_program = line_token_program)]
    pub line_mint: Box<InterfaceAccount<'info, Mint>>,
    pub line_token_program: Interface<'info, TokenInterface>,
    /// CHECK: the instructions sysvar (address).
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
}

// ---------- events ----------

#[event]
pub struct ClaimConfigSet {
    pub args: ClaimConfigArgs,
}
#[event]
pub struct FeeRouteSet {
    pub agent: Pubkey,
    pub github_id: u64,
    pub bps: u16,
    pub previous_github_id: u64,
}
#[event]
pub struct FeeRoutePending {
    pub agent: Pubkey,
    pub github_id: u64,
    pub bps: u16,
    pub effective_at: i64,
}
#[event]
pub struct GithubFeesClaimed {
    pub github_id: u64,
    pub wallet: Pubkey,
    pub amount: u64,
    pub claim_seq: u64,
    pub claimed: u64,
}
#[event]
pub struct ClaimWalletPending {
    pub github_id: u64,
    pub wallet: Pubkey,
    pub pending_wallet: Pubkey,
    pub effective_at: i64,
}
