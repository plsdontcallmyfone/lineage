//! Bonded challenges (SPEC 10.8, milestone M4). Any registered agent may contest a final verdict,
//! a slash or an epoch root within `window_s` by bonding `bond` `$LINE` from any wallet it names
//! as payer. Core resolves each challenge offchain by fresh random replays (or, for an epoch root,
//! by recomputing it from the public log) and records the outcome here with its Core authority:
//!
//! - upheld: the bond goes back with `reward` from the compute reserve; a contested slash is
//!   reversed (its amount moves from the reserve back into the agent's bond, the strike is removed),
//!   and a contested epoch root may be corrected while nothing of it has been claimed;
//! - failed: the bond goes to the compute reserve;
//! - void (Core could not decide, for example too few independent verifiers): the bond goes back.
//!
//! A challenge Core leaves unresolved past `resolve_timeout_s` is expired by anyone and its bond
//! returned. Payouts of an epoch are held (`claim` refuses) until `window_s` after the epoch was
//! posted and while any verdict or epoch challenge on it is open, so a corrected root is the only
//! one ever paid. One challenge per subject (`["challenge", kind, subject]`): its resolution is
//! final, which also makes a slash reversible at most once.
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};

use crate::{Agent, Config, Epoch, RegistryError, SlashReceipt, AGENT_SEED, BOND_VAULT_SEED, CONFIG_SEED, EPOCH_SEED, RESERVE_SEED, SLASH_SEED,
    VAULT_AUTHORITY_SEED};

pub const CHALLENGE_CONFIG_SEED: &[u8] = b"challenge_config";
pub const CHALLENGE_VAULT_SEED: &[u8] = b"challenge_vault";
pub const CHALLENGE_SEED: &[u8] = b"challenge";
pub const GATE_SEED: &[u8] = b"challenge_gate";

/// A final candidate verdict (subject: the candidate id); held against the epoch its units land in.
pub const KIND_VERDICT: u8 = 0;
/// A slash (subject: Core's 32-byte slash id, the `SlashReceipt` seed).
pub const KIND_SLASH: u8 = 1;
/// A posted epoch's roots (subject: the epoch number, little-endian, zero padded).
pub const KIND_EPOCH: u8 = 2;

pub const CH_OPEN: u8 = 0;
pub const CH_UPHELD: u8 = 1;
pub const CH_FAILED: u8 = 2;
pub const CH_VOID: u8 = 3;
pub const CH_EXPIRED: u8 = 4;

/// The subject of an epoch challenge: the epoch number, so one epoch has at most one.
pub fn epoch_subject(epoch: u64) -> [u8; 32] {
    let mut s = [0u8; 32];
    s[..8].copy_from_slice(&epoch.to_le_bytes());
    s
}

#[account]
#[derive(InitSpace)]
pub struct ChallengeConfig {
    /// Seconds after the subject (verdict epoch post, slash, epoch post) during which it may be contested.
    pub window_s: i64,
    /// `$LINE` a challenger bonds.
    pub bond: u64,
    /// `$LINE` paid from the compute reserve to an upheld challenger (capped by the reserve).
    pub reward: u64,
    /// After this many seconds an unresolved challenge may be expired by anyone (bond returned).
    pub resolve_timeout_s: i64,
    pub paused: bool,
    /// Challenges open now (all kinds).
    pub open: u32,
    pub bump: u8,
    /// Upheld rewards are capped at the registry's `max_rebate_per_epoch` per `epoch_length_s` window
    /// (audit A1-05): the window index (`unix_time / epoch_length_s`) and what was paid in it. These
    /// two fields took 16 of the 32 reserved bytes, so the account size did not change.
    pub reward_window: u64,
    pub rewards_in_window: u64,
    pub reserved: [u8; 16],
}

#[account]
#[derive(InitSpace)]
pub struct Challenge {
    pub kind: u8,
    pub subject: [u8; 32],
    /// The epoch whose payouts the challenge holds (verdict, epoch) or the slash's epoch.
    pub epoch: u64,
    /// The challenger's agent id (its `Agent` record signed through its signing key).
    pub challenger: Pubkey,
    pub payer: Pubkey,
    /// Token account the bond (and any reward) is returned to: the payer's.
    pub refund_token: Pubkey,
    pub bond: u64,
    /// sha256 of the challenger's claim document (what it says is wrong), opaque here.
    pub claim: [u8; 32],
    pub opened_at: i64,
    pub status: u8,
    pub resolved_at: i64,
    /// sha256 of Core's resolution document (replays, judgement, recomputed roots).
    pub evidence: [u8; 32],
    pub reward: u64,
    /// Slash amount moved back into the agent's bond (upheld slash challenges).
    pub reversed: u64,
    pub corrected: bool,
    pub bump: u8,
}

/// One per epoch any challenge named: `open` holds the epoch's claims while it is above zero.
#[account]
#[derive(InitSpace)]
pub struct ChallengeGate {
    pub epoch: u64,
    pub open: u32,
    pub opened: u32,
    pub upheld: u32,
    pub corrected: bool,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ChallengeConfigArgs {
    pub window_s: i64,
    pub bond: u64,
    pub reward: u64,
    pub resolve_timeout_s: i64,
    pub paused: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct OpenChallengeArgs {
    pub kind: u8,
    pub subject: [u8; 32],
    pub epoch: u64,
    pub claim: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct CorrectedRoots {
    pub payout_root: [u8; 32],
    pub lineage_root: [u8; 32],
    pub record_root: [u8; 32],
    pub total_units_micro: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ResolveChallengeArgs {
    pub outcome: u8,
    pub evidence: [u8; 32],
    pub corrected: Option<CorrectedRoots>,
}

/// Reads a program-owned account that may not exist yet (an uninitialized PDA): None when empty.
pub fn load_optional<T: AccountDeserialize>(info: &AccountInfo) -> Result<Option<T>> {
    if info.owner != &crate::ID || info.data_len() == 0 {
        return Ok(None);
    }
    Ok(Some(T::try_deserialize(&mut &info.try_borrow_data()?[..])?))
}

/// `claim`'s hold (called with the claim's `challenge_config` and `challenge_gate` PDAs): nothing of
/// an epoch is paid before `window_s` after its post, nor while a challenge on it is open.
pub fn check_claim_hold(challenge_config: &AccountInfo, gate: &AccountInfo, epoch: &Epoch, now: i64) -> Result<()> {
    if let Some(cc) = load_optional::<ChallengeConfig>(challenge_config)? {
        require!(now >= epoch.posted_at.saturating_add(cc.window_s), RegistryError::ClaimHeld);
    }
    if let Some(g) = load_optional::<ChallengeGate>(gate)? {
        require!(g.open == 0, RegistryError::ClaimHeld);
    }
    Ok(())
}

fn transfer_from_vault<'info>(token_program: &Interface<'info, TokenInterface>, from: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>, to: &AccountInfo<'info>, authority: &UncheckedAccount<'info>, bump: u8,
    amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &[bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(token_program.to_account_info(), TransferChecked {
            from: from.to_account_info(),
            mint: mint.to_account_info(),
            to: to.clone(),
            authority: authority.to_account_info(),
        }, &[seeds]),
        amount,
        mint.decimals,
    )
}

/// Whether a challenge's refund account can still take a transfer: a token account of `token_program`
/// for `mint`, initialized and not frozen, that does not demand a memo on incoming transfers. A
/// challenger who closes, freezes or memo-locks it after opening would otherwise make every
/// `resolve_challenge` and `expire_challenge` fail and hold the epoch's payouts forever (audit
/// A1-02); such a bond goes to the compute reserve instead.
pub fn refund_usable(info: &AccountInfo, mint: &Pubkey, token_program: &Pubkey) -> bool {
    use anchor_spl::token_2022::spl_token_2022::extension::{memo_transfer::MemoTransfer, BaseStateWithExtensions, StateWithExtensions};
    use anchor_spl::token_2022::spl_token_2022::state::{Account as TokenState, AccountState};
    if info.owner != token_program {
        return false;
    }
    let Ok(data) = info.try_borrow_data() else { return false };
    let Ok(acct) = StateWithExtensions::<TokenState>::unpack(&data) else { return false };
    if acct.base.mint != *mint || acct.base.state != AccountState::Initialized {
        return false;
    }
    if let Ok(m) = acct.get_extension::<MemoTransfer>() {
        if bool::from(m.require_incoming_transfer_memos) {
            return false;
        }
    }
    true
}

pub fn handle_set_config(ctx: Context<SetChallengeConfig>, args: ChallengeConfigArgs) -> Result<()> {
    require!(args.window_s > 0 && args.resolve_timeout_s > 0 && args.bond > 0, RegistryError::InvalidParams);
    let cc = &mut ctx.accounts.challenge_config;
    cc.window_s = args.window_s;
    cc.bond = args.bond;
    cc.reward = args.reward;
    cc.resolve_timeout_s = args.resolve_timeout_s;
    cc.paused = args.paused;
    cc.bump = ctx.bumps.challenge_config;
    emit!(ChallengeConfigSet { window_s: args.window_s, bond: args.bond, reward: args.reward, resolve_timeout_s: args.resolve_timeout_s,
        paused: args.paused });
    Ok(())
}

pub fn handle_open(ctx: Context<OpenChallenge>, args: OpenChallengeArgs) -> Result<()> {
    let c = &ctx.accounts.config;
    let cc = &ctx.accounts.challenge_config;
    require!(!c.paused && !cc.paused, RegistryError::Paused);
    let rec = &ctx.accounts.challenger_record;
    require!(rec.signing_key != Pubkey::default(), RegistryError::KeyRevoked);
    require_keys_eq!(ctx.accounts.signing_key.key(), rec.signing_key, RegistryError::Unauthorized);
    let now = Clock::get()?.unix_timestamp;
    match args.kind {
        KIND_VERDICT | KIND_EPOCH => {
            if args.kind == KIND_EPOCH {
                require!(args.subject == epoch_subject(args.epoch), RegistryError::ChallengeSubject);
            }
            let info = ctx.accounts.epoch_account.to_account_info();
            match load_optional::<Epoch>(&info)? {
                Some(e) => require!(now < e.posted_at.saturating_add(cc.window_s), RegistryError::ChallengeWindow),
                None => {
                    // a verdict whose epoch is not posted yet: only the next epoch can hold it
                    require!(args.kind == KIND_VERDICT, RegistryError::ChallengeEpoch);
                    if c.epochs_posted > 0 {
                        require!(Some(args.epoch) == c.last_epoch.checked_add(1), RegistryError::ChallengeEpoch);
                    }
                }
            }
        }
        KIND_SLASH => {
            let r = ctx.accounts.slash_receipt.as_ref().ok_or(RegistryError::ChallengeSubject)?;
            let expected = Pubkey::find_program_address(&[SLASH_SEED, &args.subject], &crate::ID).0;
            require_keys_eq!(r.key(), expected, RegistryError::ChallengeSubject);
            require!(r.epoch == args.epoch, RegistryError::ChallengeEpoch);
            require!(now < r.slashed_at.saturating_add(cc.window_s), RegistryError::ChallengeWindow);
        }
        _ => return err!(RegistryError::ChallengeKind),
    }
    let bond = cc.bond;
    token_interface::transfer_checked(
        CpiContext::new(ctx.accounts.token_program.to_account_info(), TransferChecked {
            from: ctx.accounts.payer_token.to_account_info(),
            mint: ctx.accounts.mint.to_account_info(),
            to: ctx.accounts.challenge_vault.to_account_info(),
            authority: ctx.accounts.payer.to_account_info(),
        }),
        bond,
        ctx.accounts.mint.decimals,
    )?;
    let ch = &mut ctx.accounts.challenge;
    ch.kind = args.kind;
    ch.subject = args.subject;
    ch.epoch = args.epoch;
    ch.challenger = rec.agent;
    ch.payer = ctx.accounts.payer.key();
    ch.refund_token = ctx.accounts.payer_token.key();
    ch.bond = bond;
    ch.claim = args.claim;
    ch.opened_at = now;
    ch.status = CH_OPEN;
    ch.resolved_at = 0;
    ch.evidence = [0; 32];
    ch.reward = 0;
    ch.reversed = 0;
    ch.corrected = false;
    ch.bump = ctx.bumps.challenge;
    let g = &mut ctx.accounts.gate;
    g.epoch = args.epoch;
    g.bump = ctx.bumps.gate;
    if args.kind != KIND_SLASH {
        g.open = g.open.checked_add(1).ok_or(RegistryError::Overflow)?;
        g.opened = g.opened.saturating_add(1);
    }
    let cc = &mut ctx.accounts.challenge_config;
    cc.open = cc.open.saturating_add(1);
    emit!(ChallengeOpened { challenge: ch.key(), kind: args.kind, subject: args.subject, epoch: args.epoch, challenger: rec.agent, bond });
    Ok(())
}

pub fn handle_resolve(ctx: Context<ResolveChallenge>, args: ResolveChallengeArgs) -> Result<()> {
    let c = &ctx.accounts.config;
    require!(!c.paused, RegistryError::Paused);
    let ch = &ctx.accounts.challenge;
    require!(ch.status == CH_OPEN, RegistryError::ChallengeNotOpen);
    require!(matches!(args.outcome, CH_UPHELD | CH_FAILED | CH_VOID), RegistryError::ChallengeOutcome);
    require!(args.corrected.is_none() || (args.outcome == CH_UPHELD && ch.kind != KIND_SLASH), RegistryError::ChallengeOutcome);
    let (kind, bond, subject, epoch_n) = (ch.kind, ch.bond, ch.subject, ch.epoch);
    let bump = c.vault_authority_bump;
    let (reward_cap, epoch_length_s) = (c.max_rebate_per_epoch, c.params.epoch_length_s);
    let now = Clock::get()?.unix_timestamp;
    let refund_ok = refund_usable(&ctx.accounts.refund_token, &ctx.accounts.mint.key(), &ctx.accounts.token_program.key());
    let refund_to = if refund_ok { ctx.accounts.refund_token.to_account_info() } else { ctx.accounts.reserve_vault.to_account_info() };
    let mut reversed = 0u64;
    let mut reward = 0u64;
    let mut corrected = false;
    if args.outcome == CH_UPHELD {
        if kind == KIND_SLASH {
            // the contested slash is reversed: its amount (as far as the reserve holds it) goes back into the bond
            let r = ctx.accounts.slash_receipt.as_ref().ok_or(RegistryError::ChallengeSubject)?;
            let expected = Pubkey::find_program_address(&[SLASH_SEED, &subject], &crate::ID).0;
            require_keys_eq!(r.key(), expected, RegistryError::ChallengeSubject);
            let bond_vault = ctx.accounts.bond_vault.as_ref().ok_or(RegistryError::ChallengeSubject)?;
            require_keys_eq!(bond_vault.key(), Pubkey::find_program_address(&[BOND_VAULT_SEED], &crate::ID).0, RegistryError::ChallengeSubject);
            let (r_amount, r_epoch, r_agent) = (r.amount, r.epoch, r.agent);
            reversed = r_amount.min(ctx.accounts.reserve_vault.amount);
            transfer_from_vault(&ctx.accounts.token_program, &ctx.accounts.reserve_vault, &ctx.accounts.mint, &bond_vault.to_account_info(),
                &ctx.accounts.vault_authority, bump, reversed)?;
            let limit = c.params.strike_limit;
            let a = ctx.accounts.agent_record.as_mut().ok_or(RegistryError::ChallengeSubject)?;
            require_keys_eq!(a.agent, r_agent, RegistryError::ChallengeSubject);
            a.bond = a.bond.checked_add(reversed).ok_or(RegistryError::Overflow)?;
            a.slashed_total = a.slashed_total.saturating_sub(reversed);
            a.strikes_total = a.strikes_total.saturating_sub(1);
            if a.strikes_epoch == r_epoch {
                a.strikes_in_epoch = a.strikes_in_epoch.saturating_sub(1);
                // lift the suspension this strike caused (residual: an earlier suspension through
                // the same epoch is lifted with it; Core keeps its own strike count, SPEC 13.6)
                if (limit == 0 || a.strikes_in_epoch < limit) && a.suspended_through_epoch == r_epoch.saturating_add(1) {
                    a.suspended_through_epoch = 0;
                }
            }
            ctx.accounts.reserve_vault.reload()?;
        }
        if let Some(roots) = args.corrected {
            let e = ctx.accounts.epoch.as_mut().ok_or(RegistryError::ChallengeEpoch)?;
            require!(e.epoch == epoch_n, RegistryError::ChallengeEpoch);
            require!(e.claims == 0 && e.claimed_amount == 0, RegistryError::ChallengeEpoch);
            e.payout_root = roots.payout_root;
            e.lineage_root = roots.lineage_root;
            e.record_root = roots.record_root;
            e.total_units_micro = roots.total_units_micro;
            corrected = true;
            emit!(EpochCorrected { epoch: epoch_n, payout_root: roots.payout_root, lineage_root: roots.lineage_root, record_root: roots.record_root,
                total_units_micro: roots.total_units_micro });
        }
        transfer_from_vault(&ctx.accounts.token_program, &ctx.accounts.challenge_vault, &ctx.accounts.mint, &refund_to,
            &ctx.accounts.vault_authority, bump, bond)?;
        if refund_ok {
            // At most `max_rebate_per_epoch` of rewards per `epoch_length_s` window (audit A1-05): the
            // reserve leaves through Core's key only at bounded rates, as `post_epoch` rebates do.
            let window = (now.max(0) as u64) / (epoch_length_s.max(1) as u64);
            let cc = &mut ctx.accounts.challenge_config;
            if cc.reward_window != window {
                cc.reward_window = window;
                cc.rewards_in_window = 0;
            }
            reward = cc.reward.min(ctx.accounts.reserve_vault.amount).min(reward_cap.saturating_sub(cc.rewards_in_window));
            cc.rewards_in_window = cc.rewards_in_window.saturating_add(reward);
            transfer_from_vault(&ctx.accounts.token_program, &ctx.accounts.reserve_vault, &ctx.accounts.mint, &refund_to,
                &ctx.accounts.vault_authority, bump, reward)?;
        }
    } else if args.outcome == CH_FAILED {
        transfer_from_vault(&ctx.accounts.token_program, &ctx.accounts.challenge_vault, &ctx.accounts.mint, &ctx.accounts.reserve_vault.to_account_info(),
            &ctx.accounts.vault_authority, bump, bond)?;
    } else {
        transfer_from_vault(&ctx.accounts.token_program, &ctx.accounts.challenge_vault, &ctx.accounts.mint, &refund_to,
            &ctx.accounts.vault_authority, bump, bond)?;
    }
    if !refund_ok && args.outcome != CH_FAILED {
        emit!(ChallengeRefundForfeited { challenge: ctx.accounts.challenge.key(), refund_token: ctx.accounts.refund_token.key(), amount: bond });
    }
    let g = &mut ctx.accounts.gate;
    if kind != KIND_SLASH {
        g.open = g.open.saturating_sub(1);
    }
    if args.outcome == CH_UPHELD {
        g.upheld = g.upheld.saturating_add(1);
    }
    g.corrected |= corrected;
    let cc = &mut ctx.accounts.challenge_config;
    cc.open = cc.open.saturating_sub(1);
    let ch = &mut ctx.accounts.challenge;
    ch.status = args.outcome;
    ch.resolved_at = now;
    ch.evidence = args.evidence;
    ch.reward = reward;
    ch.reversed = reversed;
    ch.corrected = corrected;
    emit!(ChallengeResolved { challenge: ch.key(), kind, subject, epoch: epoch_n, outcome: args.outcome, evidence: args.evidence, reward, reversed,
        corrected });
    Ok(())
}

pub fn handle_expire(ctx: Context<ExpireChallenge>) -> Result<()> {
    let ch = &ctx.accounts.challenge;
    require!(ch.status == CH_OPEN, RegistryError::ChallengeNotOpen);
    let now = Clock::get()?.unix_timestamp;
    require!(now >= ch.opened_at.saturating_add(ctx.accounts.challenge_config.resolve_timeout_s), RegistryError::ChallengeTimeout);
    let (kind, bond) = (ch.kind, ch.bond);
    let refund_ok = refund_usable(&ctx.accounts.refund_token, &ctx.accounts.mint.key(), &ctx.accounts.token_program.key());
    let refund_to = if refund_ok { ctx.accounts.refund_token.to_account_info() } else { ctx.accounts.reserve_vault.to_account_info() };
    transfer_from_vault(&ctx.accounts.token_program, &ctx.accounts.challenge_vault, &ctx.accounts.mint, &refund_to,
        &ctx.accounts.vault_authority, ctx.accounts.config.vault_authority_bump, bond)?;
    if !refund_ok {
        emit!(ChallengeRefundForfeited { challenge: ctx.accounts.challenge.key(), refund_token: ctx.accounts.refund_token.key(), amount: bond });
    }
    if kind != KIND_SLASH {
        let g = &mut ctx.accounts.gate;
        g.open = g.open.saturating_sub(1);
    }
    let cc = &mut ctx.accounts.challenge_config;
    cc.open = cc.open.saturating_sub(1);
    let ch = &mut ctx.accounts.challenge;
    ch.status = CH_EXPIRED;
    ch.resolved_at = now;
    emit!(ChallengeExpired { challenge: ch.key(), kind, subject: ch.subject, epoch: ch.epoch });
    Ok(())
}

// ---------- accounts ----------

#[derive(Accounts)]
pub struct SetChallengeConfig<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ RegistryError::Unauthorized, has_one = mint, has_one = token_program)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(init_if_needed, payer = admin, space = 8 + ChallengeConfig::INIT_SPACE, seeds = [CHALLENGE_CONFIG_SEED], bump)]
    pub challenge_config: Box<Account<'info, ChallengeConfig>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: PDA signer of every vault.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = admin, seeds = [CHALLENGE_VAULT_SEED], bump, token::mint = mint, token::authority = vault_authority,
        token::token_program = token_program)]
    pub challenge_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: OpenChallengeArgs)]
pub struct OpenChallenge<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = mint, has_one = token_program)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [CHALLENGE_CONFIG_SEED], bump = challenge_config.bump)]
    pub challenge_config: Box<Account<'info, ChallengeConfig>>,
    #[account(seeds = [AGENT_SEED, challenger_record.agent.as_ref()], bump = challenger_record.bump)]
    pub challenger_record: Box<Account<'info, Agent>>,
    /// The challenger's current signing key (registry `Agent.signing_key`).
    pub signing_key: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, token::mint = mint, token::authority = payer, token::token_program = token_program)]
    pub payer_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = payer, space = 8 + Challenge::INIT_SPACE, seeds = [CHALLENGE_SEED, &[args.kind], &args.subject], bump)]
    pub challenge: Box<Account<'info, Challenge>>,
    #[account(init_if_needed, payer = payer, space = 8 + ChallengeGate::INIT_SPACE, seeds = [GATE_SEED, &args.epoch.to_le_bytes()], bump)]
    pub gate: Box<Account<'info, ChallengeGate>>,
    /// CHECK: the registry's `Epoch` PDA for `args.epoch`, read only if it exists (posted).
    #[account(seeds = [EPOCH_SEED, &args.epoch.to_le_bytes()], bump)]
    pub epoch_account: UncheckedAccount<'info>,
    /// The contested slash (slash challenges only).
    pub slash_receipt: Option<Box<Account<'info, SlashReceipt>>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, seeds = [CHALLENGE_VAULT_SEED], bump)]
    pub challenge_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveChallenge<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = core_authority @ RegistryError::Unauthorized, has_one = mint,
        has_one = token_program)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [CHALLENGE_CONFIG_SEED], bump = challenge_config.bump)]
    pub challenge_config: Box<Account<'info, ChallengeConfig>>,
    pub core_authority: Signer<'info>,
    #[account(mut, seeds = [CHALLENGE_SEED, &[challenge.kind], &challenge.subject], bump = challenge.bump)]
    pub challenge: Box<Account<'info, Challenge>>,
    #[account(mut, seeds = [GATE_SEED, &challenge.epoch.to_le_bytes()], bump = gate.bump)]
    pub gate: Box<Account<'info, ChallengeGate>>,
    /// CHECK: the challenge's recorded refund account (address); it may have been closed, frozen or
    /// memo-locked since the open, so it is checked with `refund_usable` and never deserialized.
    #[account(mut, address = challenge.refund_token @ RegistryError::BadDestination)]
    pub refund_token: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: PDA signer.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [CHALLENGE_VAULT_SEED], bump)]
    pub challenge_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [RESERVE_SEED], bump)]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// The challenged epoch, for a correction (upheld verdict or epoch challenges).
    #[account(mut, seeds = [EPOCH_SEED, &challenge.epoch.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Option<Box<Account<'info, Epoch>>>,
    /// The contested slash, its agent and the bond vault (upheld slash challenges).
    pub slash_receipt: Option<Box<Account<'info, SlashReceipt>>>,
    #[account(mut, seeds = [AGENT_SEED, agent_record.agent.as_ref()], bump = agent_record.bump)]
    pub agent_record: Option<Box<Account<'info, Agent>>>,
    #[account(mut)]
    pub bond_vault: Option<Box<InterfaceAccount<'info, TokenAccount>>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct ExpireChallenge<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = mint, has_one = token_program)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [CHALLENGE_CONFIG_SEED], bump = challenge_config.bump)]
    pub challenge_config: Box<Account<'info, ChallengeConfig>>,
    #[account(mut, seeds = [CHALLENGE_SEED, &[challenge.kind], &challenge.subject], bump = challenge.bump)]
    pub challenge: Box<Account<'info, Challenge>>,
    #[account(mut, seeds = [GATE_SEED, &challenge.epoch.to_le_bytes()], bump = gate.bump)]
    pub gate: Box<Account<'info, ChallengeGate>>,
    /// CHECK: the challenge's recorded refund account (address); it may have been closed, frozen or
    /// memo-locked since the open, so it is checked with `refund_usable` and never deserialized.
    #[account(mut, address = challenge.refund_token @ RegistryError::BadDestination)]
    pub refund_token: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: PDA signer.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [CHALLENGE_VAULT_SEED], bump)]
    pub challenge_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    /// The compute reserve: receives the bond when the refund account can no longer take it (audit A1-02).
    #[account(mut, seeds = [RESERVE_SEED], bump)]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

// ---------- events ----------

#[event]
pub struct ChallengeConfigSet {
    pub window_s: i64,
    pub bond: u64,
    pub reward: u64,
    pub resolve_timeout_s: i64,
    pub paused: bool,
}
#[event]
pub struct ChallengeOpened {
    pub challenge: Pubkey,
    pub kind: u8,
    pub subject: [u8; 32],
    pub epoch: u64,
    pub challenger: Pubkey,
    pub bond: u64,
}
#[event]
pub struct ChallengeResolved {
    pub challenge: Pubkey,
    pub kind: u8,
    pub subject: [u8; 32],
    pub epoch: u64,
    pub outcome: u8,
    pub evidence: [u8; 32],
    pub reward: u64,
    pub reversed: u64,
    pub corrected: bool,
}
#[event]
pub struct ChallengeExpired {
    pub challenge: Pubkey,
    pub kind: u8,
    pub subject: [u8; 32],
    pub epoch: u64,
}
/// A bond that could not be returned (its refund account was closed, frozen or memo-locked) went to
/// the compute reserve (audit A1-02).
#[event]
pub struct ChallengeRefundForfeited {
    pub challenge: Pubkey,
    pub refund_token: Pubkey,
    pub amount: u64,
}
#[event]
pub struct EpochCorrected {
    pub epoch: u64,
    pub payout_root: [u8; 32],
    pub lineage_root: [u8; 32],
    pub record_root: [u8; 32],
    pub total_units_micro: u64,
}
