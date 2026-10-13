//! `units_bounty` (docs/plans/OPEN-BOUNTIES.md, option A): bounties anyone can post. A wallet escrows
//! `$UNITS` from its own token account for one unit, one metric and a required improvement; the escrow
//! is paid only to the author of an accepted generation that meets those terms, proven by Core's
//! result leaf against the registry's `Epoch.record_root`; at expiry it returns to the funder.
//!
//! This program holds bounty escrows and nothing else. It reads `units_registry` accounts (its Config
//! and its Epochs) and never calls or changes `units_registry`, `units_launch` or `units_msg`.
//!
//! The result leaf is Core's (packages/core/src/records.ts `resultLeaf`), one per accepted metric
//! generation, rebuilt here byte for byte with `units_registry::leaf`:
//! `leafHash(canonicalJson({ accepted_at, author, epoch, gen_id, height, improvement_bps,
//! kind: "bounty_result", lineage_id, target }))`.
//!
//! What a claim must show, all checked here:
//! - the leaf is in the record root of the registry's own Epoch account (address and owner checked),
//!   so only a root the Core authority posted can pay, and a leaf with any field changed has no proof;
//! - that epoch is one the registry posted after the bounty opened and no later than its deadline,
//!   and is outside the registry's challenge hold (window passed, no open challenge);
//! - the generation was accepted at or after the bounty's creation, on the bounty's unit and metric,
//!   with `improvement_bps` at least the bounty's `min_improvement_bps`;
//! - the paid account is the compute vault of the leaf's `author` under the launch program.
//!
//! Ordering: a claim stands for `contest_s`; during that time a valid claim of a strictly lower
//! generation height replaces it, so the earliest qualifying generation wins whoever sends first.
//!
//! Terms a funder agreed to never change under it: `fee_bps`, `contest_s` and the refund time are
//! copied into the bounty at open. The admin edits settings for later bounties, pauses, and withdraws
//! collected fees; no admin instruction moves an escrow.
//!
//! An escrow leaves its vault in two ways only: `pay` to the winner, or `refund` to the funder after
//! the bounty's refund time. There is no cancel: the funder cannot take a posted reward back early.
#![allow(clippy::result_large_err, clippy::too_many_arguments)]
use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token_interface::{self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked};
use units_registry::leaf::{self, Hash};

#[cfg(not(feature = "mainnet"))]
declare_id!("9559XC7tdHYv5H9UscqPnbUTPPBt3w2pX5292hRKqbXR");
#[cfg(feature = "mainnet")]
declare_id!("BxJzesTvwPWw9MU15wRebr9PKmpMmiJTUuwMgyKUZPSK");

pub const CONFIG_SEED: &[u8] = b"config";
pub const AUTHORITY_SEED: &[u8] = b"authority";
pub const FEE_VAULT_SEED: &[u8] = b"fee_vault";
pub const BOUNTY_SEED: &[u8] = b"bounty";
pub const VAULT_SEED: &[u8] = b"vault";

pub const BPS: u64 = 10_000;
pub const MAX_PROOF: usize = 32;
pub const MAX_TARGET_ITEMS: usize = 8;
pub const MAX_TARGET_LEN: usize = 96;

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_PAID: u8 = 1;
pub const STATUS_REFUNDED: u8 = 2;

// ---------- leaf ----------

fn quoted_hex(h: &Hash, out: &mut Vec<u8>) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push(b'"');
    for b in h {
        out.push(HEX[(b >> 4) as usize]);
        out.push(HEX[(b & 15) as usize]);
    }
    out.push(b'"');
}

/// The canonical JSON of a target (`"name"` or `["a","b"]`), or None if a string needs an escape.
pub fn target_json(items: &[String], is_list: bool) -> Option<Vec<u8>> {
    if items.is_empty() || (!is_list && items.len() != 1) || items.len() > MAX_TARGET_ITEMS {
        return None;
    }
    let mut out = Vec::with_capacity(64);
    if is_list {
        out.push(b'[');
    }
    for (i, s) in items.iter().enumerate() {
        if !leaf::safe_str(s.as_bytes()) || s.len() > MAX_TARGET_LEN {
            return None;
        }
        if i > 0 {
            out.push(b',');
        }
        out.push(b'"');
        out.extend_from_slice(s.as_bytes());
        out.push(b'"');
    }
    if is_list {
        out.push(b']');
    }
    Some(out)
}

/// protocol `hashJson(target)` = sha256 of its canonical JSON.
pub fn target_digest(target_json: &[u8]) -> Hash {
    hashv(&[target_json]).to_bytes()
}

/// The canonical JSON object of a result (keys sorted).
pub fn result_json(accepted_at: u64, author: &Pubkey, epoch: u64, gen_id: &Hash, height: u64, improvement_bps: u64, lineage_id: &Hash,
    target_json: &[u8]) -> Vec<u8> {
    let mut o = Vec::with_capacity(360 + target_json.len());
    o.extend_from_slice(b"{\"accepted_at\":");
    leaf::decimal(accepted_at, &mut o);
    o.extend_from_slice(b",\"author\":\"");
    let (s, n) = leaf::base58_32(&author.to_bytes());
    o.extend_from_slice(&s[..n]);
    o.extend_from_slice(b"\",\"epoch\":");
    leaf::decimal(epoch, &mut o);
    o.extend_from_slice(b",\"gen_id\":");
    quoted_hex(gen_id, &mut o);
    o.extend_from_slice(b",\"height\":");
    leaf::decimal(height, &mut o);
    o.extend_from_slice(b",\"improvement_bps\":");
    leaf::decimal(improvement_bps, &mut o);
    o.extend_from_slice(b",\"kind\":\"bounty_result\",\"lineage_id\":");
    quoted_hex(lineage_id, &mut o);
    o.extend_from_slice(b",\"target\":");
    o.extend_from_slice(target_json);
    o.push(b'}');
    o
}

/// Core's result leaf.
pub fn result_leaf(accepted_at: u64, author: &Pubkey, epoch: u64, gen_id: &Hash, height: u64, improvement_bps: u64, lineage_id: &Hash,
    target_json: &[u8]) -> Hash {
    leaf::leaf_hash(&result_json(accepted_at, author, epoch, gen_id, height, improvement_bps, lineage_id, target_json))
}

// ---------- program ----------

#[program]
pub mod units_bounty {
    use super::*;

    /// Once, by the program's upgrade authority (checked through ProgramData, so nobody can front-run
    /// the deploy). The quote mint and the launch program are the registry's, fixed here for good.
    pub fn initialize(ctx: Context<Initialize>, admin: Pubkey, settings: Settings) -> Result<()> {
        settings.validate()?;
        require!(admin != Pubkey::default(), BountyError::InvalidArgs);
        let c = &mut ctx.accounts.config;
        c.admin = admin;
        c.pending_admin = Pubkey::default();
        c.mint = ctx.accounts.mint.key();
        c.token_program = ctx.accounts.token_program.key();
        c.launch_program = ctx.accounts.registry_config.launch_program;
        c.settings = settings;
        c.opened = 0;
        c.bump = ctx.bumps.config;
        c.authority_bump = ctx.bumps.authority;
        c.reserved = [0u8; 64];
        emit!(SettingsSet { settings });
        Ok(())
    }

    /// Admin: every setting (minimum, deadline range, grace, contest time, fee, pause). An open
    /// bounty keeps the fee, contest time and refund time it was opened with.
    pub fn set_settings(ctx: Context<AdminOnly>, settings: Settings) -> Result<()> {
        settings.validate()?;
        ctx.accounts.config.settings = settings;
        emit!(SettingsSet { settings });
        Ok(())
    }

    /// Admin: names the next admin, who takes over with `accept_admin` (default clears the proposal).
    pub fn propose_admin(ctx: Context<AdminOnly>, new_admin: Pubkey) -> Result<()> {
        ctx.accounts.config.pending_admin = new_admin;
        emit!(AdminProposed { admin: ctx.accounts.admin.key(), pending: new_admin });
        Ok(())
    }

    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        let c = &mut ctx.accounts.config;
        require!(c.pending_admin != Pubkey::default() && c.pending_admin == ctx.accounts.new_admin.key(), BountyError::Unauthorized);
        let old = c.admin;
        c.admin = c.pending_admin;
        c.pending_admin = Pubkey::default();
        emit!(AdminChanged { old, new: c.admin });
        Ok(())
    }

    /// Admin: moves collected fees out of the fee vault. The only token movement an admin can make.
    pub fn withdraw_fees(ctx: Context<WithdrawFees>, amount: u64) -> Result<()> {
        let c = &ctx.accounts.config;
        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[c.authority_bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.fee_vault.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.to.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            }, &[seeds]),
            amount,
            ctx.accounts.mint.decimals,
        )?;
        emit!(FeesWithdrawn { to: ctx.accounts.to.key(), amount });
        Ok(())
    }

    /// Any wallet: escrows `amount` of its own `$UNITS` for the first accepted generation on
    /// `lineage_id` whose target hashes to `target_digest` and improves it by `min_improvement_bps`.
    pub fn open_bounty(ctx: Context<OpenBounty>, args: OpenArgs) -> Result<()> {
        let c = &ctx.accounts.config;
        let s = &c.settings;
        require!(!s.paused, BountyError::Paused);
        let now = Clock::get()?.unix_timestamp;
        require!(args.amount > 0 && args.amount >= s.min_amount, BountyError::InvalidArgs);
        let ttl = args.deadline.checked_sub(now).ok_or(BountyError::InvalidArgs)?;
        require!(ttl >= s.min_ttl_s as i64 && ttl <= s.max_ttl_s as i64, BountyError::BountyTtl);
        require!(args.lineage_id != [0u8; 32] && args.target_digest != [0u8; 32], BountyError::InvalidArgs);
        require!(args.min_improvement_bps > 0 && (args.min_improvement_bps as u64) < BPS, BountyError::InvalidArgs);

        token_interface::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.funder_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
                authority: ctx.accounts.funder.to_account_info(),
            }),
            args.amount,
            ctx.accounts.mint.decimals,
        )?;
        ctx.accounts.vault.reload()?;
        // The escrow is what arrived, and the open is refused if that is not what the funder named.
        require!(ctx.accounts.vault.amount == args.amount, BountyError::InvalidArgs);

        let rc = &ctx.accounts.registry_config;
        let b = &mut ctx.accounts.bounty;
        b.funder = ctx.accounts.funder.key();
        b.bounty_id = args.bounty_id;
        b.amount = args.amount;
        b.fee_bps = s.fee_bps;
        b.terms_digest = args.terms_digest;
        b.lineage_id = args.lineage_id;
        b.target_digest = args.target_digest;
        b.min_improvement_bps = args.min_improvement_bps;
        b.min_epoch = if rc.epochs_posted == 0 { 0 } else { rc.last_epoch.saturating_add(1) };
        b.epochs_posted_at_open = rc.epochs_posted;
        b.deadline = args.deadline;
        b.created_at = now;
        b.refund_after = args.deadline.saturating_add(s.refund_grace_s as i64);
        b.contest_s = s.contest_s;
        b.status = STATUS_OPEN;
        b.winner = Pubkey::default();
        b.win_height = 0;
        b.win_epoch = 0;
        b.win_gen_id = [0u8; 32];
        b.win_improvement_bps = 0;
        b.win_leaf = [0u8; 32];
        b.claimed_at = 0;
        b.contest_until = 0;
        b.paid = 0;
        b.fee_paid = 0;
        b.closed_at = 0;
        b.bump = ctx.bumps.bounty;
        b.vault_bump = ctx.bumps.vault;
        let c = &mut ctx.accounts.config;
        c.opened = c.opened.saturating_add(1);
        emit!(BountyOpened { bounty: b.key(), funder: b.funder, bounty_id: b.bounty_id, amount: b.amount, fee_bps: b.fee_bps, terms_digest: b.terms_digest,
            lineage_id: b.lineage_id, target_digest: b.target_digest, min_improvement_bps: b.min_improvement_bps, min_epoch: b.min_epoch,
            deadline: b.deadline, refund_after: b.refund_after, contest_s: b.contest_s });
        Ok(())
    }

    /// Anyone: names the generation that wins, with its result leaf and proof. The first valid claim
    /// stands; within the bounty's contest time a valid claim of a strictly lower height replaces it.
    pub fn claim(ctx: Context<Claim>, args: ClaimArgs) -> Result<()> {
        require!(!ctx.accounts.config.settings.paused, BountyError::Paused);
        let now = Clock::get()?.unix_timestamp;
        let b = &ctx.accounts.bounty;
        require!(b.status == STATUS_OPEN, BountyError::BountyClosed);
        require!(args.proof.len() <= MAX_PROOF, BountyError::InvalidArgs);
        let standing = b.winner != Pubkey::default();
        if standing {
            require!(now < b.contest_until, BountyError::ContestOver);
            require!(args.height < b.win_height, BountyError::NotEarlier);
        } else {
            require!(now <= b.refund_after, BountyError::Expired);
        }
        // The epoch account is the registry's own PDA for `args.epoch` (owner and seeds checked by the
        // account constraints), so its record_root is what the Core authority posted.
        let ep = &ctx.accounts.registry_epoch;
        require!(ep.epoch == args.epoch && ep.record_root != [0u8; 32], BountyError::BadProof);
        require!(args.epoch >= b.min_epoch && args.accepted_at >= b.created_at, BountyError::BeforeOpen);
        require!(ep.posted_at <= b.deadline, BountyError::Late);
        // The registry's payout hold: nothing is decided on an epoch inside its challenge window or
        // while a challenge on it is open, so a root an upheld challenge corrects has decided nothing.
        units_registry::challenge::check_claim_hold(&ctx.accounts.challenge_config.to_account_info(), &ctx.accounts.challenge_gate.to_account_info(), ep, now)
            .map_err(|_| error!(BountyError::Held))?;
        let tj = target_json(&args.target, args.target_is_list).ok_or(BountyError::InvalidArgs)?;
        require!(target_digest(&tj) == b.target_digest, BountyError::WrongTarget);
        require!(args.improvement_bps >= b.min_improvement_bps as u64, BountyError::ImprovementTooLow);
        let leaf_h = result_leaf(args.accepted_at as u64, &args.author, args.epoch, &args.gen_id, args.height, args.improvement_bps, &b.lineage_id, &tj);
        require!(leaf::verify_proof(&leaf_h, &args.proof, &ep.record_root), BountyError::BadProof);

        let replaced = b.winner;
        let b = &mut ctx.accounts.bounty;
        b.winner = args.author;
        b.win_height = args.height;
        b.win_epoch = args.epoch;
        b.win_gen_id = args.gen_id;
        b.win_improvement_bps = args.improvement_bps;
        b.win_leaf = leaf_h;
        if !standing {
            b.claimed_at = now;
            b.contest_until = now.saturating_add(b.contest_s as i64);
        }
        emit!(BountyClaimed { bounty: b.key(), winner: b.winner, replaced, height: b.win_height, epoch: b.win_epoch, gen_id: b.win_gen_id,
            improvement_bps: b.win_improvement_bps, leaf: leaf_h, contest_until: b.contest_until });
        Ok(())
    }

    /// Anyone, once the contest time of the standing claim has passed: the escrow to the winner's
    /// compute vault, less the fee the bounty was opened with.
    pub fn pay(ctx: Context<Pay>) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.settings.paused, BountyError::Paused);
        let now = Clock::get()?.unix_timestamp;
        let b = &ctx.accounts.bounty;
        require!(b.status == STATUS_OPEN, BountyError::BountyClosed);
        require!(b.winner != Pubkey::default(), BountyError::NoClaim);
        require!(now >= b.contest_until, BountyError::ContestOpen);
        // The whole balance, not the escrowed amount: anyone can send tokens into the vault, and a
        // balance left behind would make the token program refuse the close. A donation follows the escrow.
        let balance = ctx.accounts.vault.amount;
        let fee = ((balance as u128) * (b.fee_bps as u128) / (BPS as u128)) as u64;
        let paid = balance - fee;
        let a = Mover { bump: c.authority_bump, vault: &ctx.accounts.vault, mint: &ctx.accounts.mint, token_program: &ctx.accounts.token_program,
            authority: &ctx.accounts.authority };
        a.send(&ctx.accounts.fee_vault.to_account_info(), fee)?;
        a.send(&ctx.accounts.winner_compute.to_account_info(), paid)?;
        a.close(&ctx.accounts.funder.to_account_info())?;
        let b = &mut ctx.accounts.bounty;
        b.status = STATUS_PAID;
        b.paid = paid;
        b.fee_paid = fee;
        b.closed_at = now;
        emit!(BountyPaid { bounty: b.key(), funder: b.funder, winner: b.winner, paid, fee, epoch: b.win_epoch, gen_id: b.win_gen_id, leaf: b.win_leaf });
        Ok(())
    }

    /// Anyone, after the bounty's refund time with no claim standing: the whole vault balance back to
    /// the funder's token account. The only way an unwon escrow leaves, and never before that time.
    /// Not stopped by a pause, so an expired reward can always be returned. Never with a claim
    /// standing: a named winner is paid, whatever the clock says.
    pub fn refund(ctx: Context<Refund>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let a = ctx.accounts;
        require!(now > a.bounty.refund_after, BountyError::NotExpired);
        require!(a.bounty.status == STATUS_OPEN, BountyError::BountyClosed);
        require!(a.bounty.winner == Pubkey::default(), BountyError::ClaimStanding);
        let amount = a.vault.amount;
        let m = Mover { bump: a.config.authority_bump, vault: &a.vault, mint: &a.mint, token_program: &a.token_program, authority: &a.authority };
        m.send(&a.funder_token.to_account_info(), amount)?;
        m.close(&a.funder.to_account_info())?;
        let b = &mut a.bounty;
        b.status = STATUS_REFUNDED;
        b.closed_at = now;
        emit!(BountyRefunded { bounty: b.key(), funder: b.funder, amount });
        Ok(())
    }
}

struct Mover<'a, 'info> {
    bump: u8,
    vault: &'a InterfaceAccount<'info, TokenAccount>,
    mint: &'a InterfaceAccount<'info, Mint>,
    token_program: &'a Interface<'info, TokenInterface>,
    authority: &'a UncheckedAccount<'info>,
}
impl<'info> Mover<'_, 'info> {
    fn send(&self, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
        if amount == 0 {
            return Ok(());
        }
        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[self.bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(self.token_program.to_account_info(), TransferChecked {
                from: self.vault.to_account_info(),
                mint: self.mint.to_account_info(),
                to: to.clone(),
                authority: self.authority.to_account_info(),
            }, &[seeds]),
            amount,
            self.mint.decimals,
        )
    }
    /// Closes the emptied vault; its rent returns to the funder, who paid it.
    fn close(&self, rent_to: &AccountInfo<'info>) -> Result<()> {
        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[self.bump]];
        token_interface::close_account(CpiContext::new_with_signer(self.token_program.to_account_info(), CloseAccount {
            account: self.vault.to_account_info(),
            destination: rent_to.clone(),
            authority: self.authority.to_account_info(),
        }, &[seeds]))
    }
}

// ---------- state ----------

/// Every setting of the program; all admin editable (`set_settings`).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Settings {
    /// Smallest escrow, in base units of the quote mint.
    pub min_amount: u64,
    /// A deadline is at least this far and at most `max_ttl_s` from the open.
    pub min_ttl_s: u32,
    pub max_ttl_s: u32,
    /// After the deadline, how long a first claim is still taken before anyone may refund. Set it
    /// above the registry's challenge window: an epoch posted at the deadline is claimable only after it.
    pub refund_grace_s: u32,
    /// How long a claim stands open to a claim of a lower height before it is paid.
    pub contest_s: u32,
    /// Fee taken from a payout, in basis points (0 = none). Never taken from a refund.
    pub fee_bps: u16,
    /// Stops open, claim and pay. Refund always works.
    pub paused: bool,
}
impl Settings {
    fn validate(&self) -> Result<()> {
        require!(self.min_amount > 0 && self.max_ttl_s > 0 && self.min_ttl_s <= self.max_ttl_s && (self.fee_bps as u64) < BPS, BountyError::InvalidArgs);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub pending_admin: Pubkey,
    /// The quote mint (`$UNITS`): the registry's, fixed at initialize.
    pub mint: Pubkey,
    pub token_program: Pubkey,
    /// The launch program whose compute vaults are paid: the registry's, fixed at initialize.
    pub launch_program: Pubkey,
    pub settings: Settings,
    /// Bounties opened so far.
    pub opened: u64,
    pub bump: u8,
    pub authority_bump: u8,
    pub reserved: [u8; 64],
}

#[account]
#[derive(InitSpace)]
pub struct Bounty {
    /// The wallet that escrowed the reward; refunds and the vault rent return to it.
    pub funder: Pubkey,
    pub bounty_id: u64,
    pub amount: u64,
    /// The fee this bounty pays at payout, fixed at open.
    pub fee_bps: u16,
    /// sha256 of the canonical terms JSON Core stores.
    pub terms_digest: [u8; 32],
    pub lineage_id: [u8; 32],
    /// protocol `hashJson(target)` of the metric (or test set) the bounty names.
    pub target_digest: [u8; 32],
    pub min_improvement_bps: u16,
    /// Only generations in epochs from here on qualify (the registry's next epoch at open).
    pub min_epoch: u64,
    /// The registry's `epochs_posted` at open. A record only: no instruction reads it.
    pub epochs_posted_at_open: u64,
    pub deadline: i64,
    pub created_at: i64,
    /// deadline + the grace in force at open; a first claim is taken until then, a refund after.
    pub refund_after: i64,
    /// The contest time in force at open.
    pub contest_s: u32,
    pub status: u8,
    /// The standing claim: the author to pay (default = none), its generation and leaf.
    pub winner: Pubkey,
    pub win_height: u64,
    pub win_epoch: u64,
    pub win_gen_id: [u8; 32],
    pub win_improvement_bps: u64,
    pub win_leaf: [u8; 32],
    /// When the first claim landed, and when the standing claim becomes payable.
    pub claimed_at: i64,
    pub contest_until: i64,
    pub paid: u64,
    pub fee_paid: u64,
    pub closed_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OpenArgs {
    pub bounty_id: u64,
    pub amount: u64,
    pub terms_digest: [u8; 32],
    pub lineage_id: [u8; 32],
    pub target_digest: [u8; 32],
    pub min_improvement_bps: u16,
    pub deadline: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ClaimArgs {
    pub epoch: u64,
    pub gen_id: [u8; 32],
    pub height: u64,
    pub improvement_bps: u64,
    /// Unix seconds Core accepted the generation.
    pub accepted_at: i64,
    /// The agent the result leaf credits; its compute vault is the one paid.
    pub author: Pubkey,
    pub target: Vec<String>,
    pub target_is_list: bool,
    pub proof: Vec<[u8; 32]>,
}

// ---------- accounts ----------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = upgrade_authority, space = 8 + Config::INIT_SPACE, seeds = [CONFIG_SEED], bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub upgrade_authority: Signer<'info>,
    #[account(seeds = [crate::ID.as_ref()], bump, seeds::program = bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()) @ BountyError::Unauthorized)]
    pub program_data: Box<Account<'info, ProgramData>>,
    /// The registry's Config: the quote mint, its token program and the launch program come from it.
    #[account(seeds = [units_registry::CONFIG_SEED], bump = registry_config.bump, seeds::program = units_registry::ID, has_one = mint, has_one = token_program)]
    pub registry_config: Box<Account<'info, units_registry::Config>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: PDA signer of every vault.
    #[account(seeds = [AUTHORITY_SEED], bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(init, payer = upgrade_authority, seeds = [FEE_VAULT_SEED], bump, token::mint = mint, token::authority = authority, token::token_program = token_program)]
    pub fee_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ BountyError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct AcceptAdmin<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub new_admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct WithdrawFees<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ BountyError::Unauthorized, has_one = mint, has_one = token_program)]
    pub config: Box<Account<'info, Config>>,
    pub admin: Signer<'info>,
    /// CHECK: PDA signer.
    #[account(seeds = [AUTHORITY_SEED], bump = config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [FEE_VAULT_SEED], bump)]
    pub fee_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub to: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(args: OpenArgs)]
pub struct OpenBounty<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = mint, has_one = token_program)]
    pub config: Box<Account<'info, Config>>,
    /// The registry's Config: its epoch cursor sets `min_epoch`.
    #[account(seeds = [units_registry::CONFIG_SEED], bump = registry_config.bump, seeds::program = units_registry::ID)]
    pub registry_config: Box<Account<'info, units_registry::Config>>,
    /// Any wallet; pays the reward and the rent.
    #[account(mut)]
    pub funder: Signer<'info>,
    #[account(mut, token::mint = mint, token::authority = funder, token::token_program = token_program)]
    pub funder_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = funder, space = 8 + Bounty::INIT_SPACE, seeds = [BOUNTY_SEED, funder.key().as_ref(), &args.bounty_id.to_le_bytes()], bump)]
    pub bounty: Box<Account<'info, Bounty>>,
    #[account(init, payer = funder, seeds = [VAULT_SEED, bounty.key().as_ref()], bump, token::mint = mint, token::authority = authority,
        token::token_program = token_program)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: PDA signer.
    #[account(seeds = [AUTHORITY_SEED], bump = config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: ClaimArgs)]
pub struct Claim<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [BOUNTY_SEED, bounty.funder.as_ref(), &bounty.bounty_id.to_le_bytes()], bump = bounty.bump)]
    pub bounty: Box<Account<'info, Bounty>>,
    /// The registry's Epoch for `args.epoch` (owner = registry via the account type, address = its PDA).
    #[account(seeds = [units_registry::EPOCH_SEED, &args.epoch.to_le_bytes()], bump = registry_epoch.bump, seeds::program = units_registry::ID)]
    pub registry_epoch: Box<Account<'info, units_registry::Epoch>>,
    /// CHECK: the registry's `ChallengeConfig` PDA, read only if it exists.
    #[account(seeds = [units_registry::CHALLENGE_CONFIG_SEED], bump, seeds::program = units_registry::ID)]
    pub challenge_config: UncheckedAccount<'info>,
    /// CHECK: the registry's `ChallengeGate` PDA of `args.epoch`, read only if it exists.
    #[account(seeds = [units_registry::GATE_SEED, &args.epoch.to_le_bytes()], bump, seeds::program = units_registry::ID)]
    pub challenge_gate: UncheckedAccount<'info>,
    /// The compute vault of `args.author` under the launch program: a claim stands only for an
    /// author that can be paid.
    #[account(seeds = [units_registry::COMPUTE_SEED, args.author.as_ref()], bump, seeds::program = config.launch_program,
        token::mint = config.mint, token::token_program = config.token_program)]
    pub winner_compute: Box<InterfaceAccount<'info, TokenAccount>>,
}

#[derive(Accounts)]
pub struct Pay<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = mint, has_one = token_program)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [BOUNTY_SEED, bounty.funder.as_ref(), &bounty.bounty_id.to_le_bytes()], bump = bounty.bump, has_one = funder)]
    pub bounty: Box<Account<'info, Bounty>>,
    #[account(mut, seeds = [VAULT_SEED, bounty.key().as_ref()], bump = bounty.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: PDA signer.
    #[account(seeds = [AUTHORITY_SEED], bump = config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: the bounty's funder (has_one); receives the vault rent.
    #[account(mut)]
    pub funder: UncheckedAccount<'info>,
    #[account(mut, seeds = [units_registry::COMPUTE_SEED, bounty.winner.as_ref()], bump, seeds::program = config.launch_program,
        token::mint = mint, token::token_program = token_program)]
    pub winner_compute: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [FEE_VAULT_SEED], bump)]
    pub fee_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct Refund<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = mint, has_one = token_program)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [BOUNTY_SEED, bounty.funder.as_ref(), &bounty.bounty_id.to_le_bytes()], bump = bounty.bump, has_one = funder)]
    pub bounty: Box<Account<'info, Bounty>>,
    #[account(mut, seeds = [VAULT_SEED, bounty.key().as_ref()], bump = bounty.vault_bump)]
    pub vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: PDA signer.
    #[account(seeds = [AUTHORITY_SEED], bump = config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    /// CHECK: the bounty's funder (has_one); receives the vault rent.
    #[account(mut)]
    pub funder: UncheckedAccount<'info>,
    /// A token account of the funder: the only place a refund can go.
    #[account(mut, token::mint = mint, token::authority = funder, token::token_program = token_program)]
    pub funder_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    pub token_program: Interface<'info, TokenInterface>,
}

// ---------- events ----------

#[event]
pub struct SettingsSet {
    pub settings: Settings,
}
#[event]
pub struct AdminProposed {
    pub admin: Pubkey,
    pub pending: Pubkey,
}
#[event]
pub struct AdminChanged {
    pub old: Pubkey,
    pub new: Pubkey,
}
#[event]
pub struct FeesWithdrawn {
    pub to: Pubkey,
    pub amount: u64,
}
#[event]
pub struct BountyOpened {
    pub bounty: Pubkey,
    pub funder: Pubkey,
    pub bounty_id: u64,
    pub amount: u64,
    pub fee_bps: u16,
    pub terms_digest: [u8; 32],
    pub lineage_id: [u8; 32],
    pub target_digest: [u8; 32],
    pub min_improvement_bps: u16,
    pub min_epoch: u64,
    pub deadline: i64,
    pub refund_after: i64,
    pub contest_s: u32,
}
#[event]
pub struct BountyClaimed {
    pub bounty: Pubkey,
    pub winner: Pubkey,
    /// The author the claim replaced, default for a first claim.
    pub replaced: Pubkey,
    pub height: u64,
    pub epoch: u64,
    pub gen_id: [u8; 32],
    pub improvement_bps: u64,
    pub leaf: [u8; 32],
    pub contest_until: i64,
}
#[event]
pub struct BountyPaid {
    pub bounty: Pubkey,
    pub funder: Pubkey,
    pub winner: Pubkey,
    pub paid: u64,
    pub fee: u64,
    pub epoch: u64,
    pub gen_id: [u8; 32],
    pub leaf: [u8; 32],
}
#[event]
pub struct BountyRefunded {
    pub bounty: Pubkey,
    pub funder: Pubkey,
    pub amount: u64,
}

#[error_code]
pub enum BountyError {
    #[msg("signer may not do this")]
    Unauthorized,
    #[msg("paused")]
    Paused,
    #[msg("invalid arguments")]
    InvalidArgs,
    #[msg("deadline outside the allowed range")]
    BountyTtl,
    #[msg("bounty is not open")]
    BountyClosed,
    #[msg("leaf is not in the posted record root")]
    BadProof,
    #[msg("generation predates the bounty")]
    BeforeOpen,
    #[msg("epoch was posted after the deadline")]
    Late,
    #[msg("epoch is inside its challenge hold")]
    Held,
    #[msg("generation is on another target")]
    WrongTarget,
    #[msg("improvement is below what the bounty requires")]
    ImprovementTooLow,
    #[msg("a claim stands and this generation is not earlier")]
    NotEarlier,
    #[msg("the contest time of the standing claim is over")]
    ContestOver,
    #[msg("the standing claim is still open to an earlier generation")]
    ContestOpen,
    #[msg("no claim to pay")]
    NoClaim,
    #[msg("the bounty expired without a claim")]
    Expired,
    #[msg("the bounty has not expired")]
    NotExpired,
    #[msg("a claim stands: the bounty pays its winner")]
    ClaimStanding,
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn target_json_shapes() {
        assert_eq!(target_json(&["ir".into()], false).unwrap(), b"\"ir\"");
        assert_eq!(target_json(&["a".into(), "b".into()], true).unwrap(), b"[\"a\",\"b\"]");
        assert!(target_json(&["a\"b".into()], false).is_none());
        assert!(target_json(&["a".into(), "b".into()], false).is_none());
        assert!(target_json(&[], true).is_none());
    }
    #[test]
    fn result_json_shape() {
        let j = result_json(7, &Pubkey::new_from_array([0u8; 32]), 3, &[0xab; 32], 12, 1500, &[0xcd; 32], b"\"encode_ir\"");
        let want = format!("{{\"accepted_at\":7,\"author\":\"{}\",\"epoch\":3,\"gen_id\":\"{}\",\"height\":12,\"improvement_bps\":1500,\"kind\":\"bounty_result\",\"lineage_id\":\"{}\",\"target\":\"encode_ir\"}}",
            "1".repeat(32), "ab".repeat(32), "cd".repeat(32));
        assert_eq!(String::from_utf8(j).unwrap(), want);
    }
}
