//! Bounties (identity and collaboration plan C6, SPEC 14.7): an agent escrows `$LINE` from its
//! compute vault for work it wants done; the escrow is released only into the compute vault of an
//! agent credited in an accepted generation, proven by a contribution leaf against the registry's
//! `Epoch.record_root`. Nothing else moves the escrow: the opener cancels only before any epoch
//! that could hold such a generation is posted, and anyone refunds after the deadline plus a grace.
//!
//! The contribution leaf is Core's (packages/core/src/records.ts `contributionLeaf`):
//! `leafHash(canonicalJson({ epoch, gen_id, lineage_id, target, candidate_commitment, members:
//! [{ agent, role, share_bps }], finder }))`, rebuilt here byte for byte with `units_registry::leaf`.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::token_interface::{self, CloseAccount, Mint, TokenAccount, TokenInterface, TransferChecked};
use units_registry::leaf::{self, Hash};

use crate::{update_awake, AgentLaunch, LaunchConfig, LaunchError, AGENT_LAUNCH_SEED, AUTHORITY_SEED, BPS, COMPUTE_SEED, LAUNCH_CONFIG_SEED, MAX_PROOF};

pub const BOUNTY_CONFIG_SEED: &[u8] = b"bounty_config";
pub const BOUNTY_SEED: &[u8] = b"bounty";
pub const BOUNTY_VAULT_SEED: &[u8] = b"bounty_vault";
pub const BOUNTY_LEDGER_SEED: &[u8] = b"bounty_ledger";
pub const BOUNTY_RECEIPT_SEED: &[u8] = b"bounty_receipt";

/// `condition_kind`: the generation's `candidate_commitment` equals `condition_value`.
pub const COND_COMMITMENT: u8 = 0;
/// `condition_kind`: any accepted generation on the lineage whose target hashes (protocol
/// `hashJson(target)`) to `condition_value`, or any target when `condition_value` is zero.
pub const COND_TARGET: u8 = 1;

pub const STATUS_OPEN: u8 = 0;
pub const STATUS_RELEASED: u8 = 1;
pub const STATUS_REFUNDED: u8 = 2;
pub const STATUS_CANCELLED: u8 = 3;

/// Member roles of a contribution leaf, in the order the instruction encodes them.
pub const ROLES: [&str; 4] = ["author", "reviewer", "harness", "finder"];
pub const ROLE_AUTHOR: u8 = 0;
pub const MAX_MEMBERS: usize = 8;
pub const MAX_TARGET_ITEMS: usize = 8;
pub const MAX_TARGET_LEN: usize = 96;

// ---------- leaf ----------

fn hex_into(h: &Hash, out: &mut Vec<u8>) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for b in h {
        out.push(HEX[(b >> 4) as usize]);
        out.push(HEX[(b & 15) as usize]);
    }
}
fn quoted_hex(h: &Hash, out: &mut Vec<u8>) {
    out.push(b'"');
    hex_into(h, out);
    out.push(b'"');
}
fn quoted_b58(k: &Pubkey, out: &mut Vec<u8>) {
    let (s, n) = leaf::base58_32(&k.to_bytes());
    out.push(b'"');
    out.extend_from_slice(&s[..n]);
    out.push(b'"');
}

/// The canonical JSON of a target (`"name"` or `["a","b"]`), or None if a string needs an escape.
pub fn target_json(items: &[String], is_list: bool) -> Option<Vec<u8>> {
    if (!is_list && items.len() != 1) || items.len() > MAX_TARGET_ITEMS {
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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemberArg {
    pub agent: Pubkey,
    /// Index into `ROLES`.
    pub role: u8,
    pub share_bps: u16,
}

/// The canonical JSON object of a contribution (keys sorted: candidate_commitment, epoch, finder,
/// gen_id, lineage_id, members, target).
pub fn contribution_json(epoch: u64, gen_id: &Hash, lineage_id: &Hash, target_json: &[u8], commitment: &Hash, members: &[MemberArg],
    finder: Option<&Pubkey>) -> Option<Vec<u8>> {
    if members.is_empty() || members.len() > MAX_MEMBERS || members.iter().any(|m| m.role as usize >= ROLES.len()) {
        return None;
    }
    let mut o = Vec::with_capacity(400 + members.len() * 80);
    o.extend_from_slice(b"{\"candidate_commitment\":");
    quoted_hex(commitment, &mut o);
    o.extend_from_slice(b",\"epoch\":");
    leaf::decimal(epoch, &mut o);
    o.extend_from_slice(b",\"finder\":");
    match finder {
        Some(f) => quoted_b58(f, &mut o),
        None => o.extend_from_slice(b"null"),
    }
    o.extend_from_slice(b",\"gen_id\":");
    quoted_hex(gen_id, &mut o);
    o.extend_from_slice(b",\"lineage_id\":");
    quoted_hex(lineage_id, &mut o);
    o.extend_from_slice(b",\"members\":[");
    for (i, m) in members.iter().enumerate() {
        if i > 0 {
            o.push(b',');
        }
        o.extend_from_slice(b"{\"agent\":");
        quoted_b58(&m.agent, &mut o);
        o.extend_from_slice(b",\"role\":\"");
        o.extend_from_slice(ROLES[m.role as usize].as_bytes());
        o.extend_from_slice(b"\",\"share_bps\":");
        leaf::decimal(m.share_bps as u64, &mut o);
        o.push(b'}');
    }
    o.extend_from_slice(b"],\"target\":");
    o.extend_from_slice(target_json);
    o.push(b'}');
    Some(o)
}

/// Core's contribution leaf.
pub fn contribution_leaf(epoch: u64, gen_id: &Hash, lineage_id: &Hash, target_json: &[u8], commitment: &Hash, members: &[MemberArg],
    finder: Option<&Pubkey>) -> Option<Hash> {
    contribution_json(epoch, gen_id, lineage_id, target_json, commitment, members, finder).map(|d| leaf::leaf_hash(&d))
}

// ---------- handlers ----------

pub(crate) fn set_bounty_config(ctx: Context<SetBountyConfig>, args: BountyConfigArgs) -> Result<()> {
    args.validate()?;
    let b = &mut ctx.accounts.bounty_config;
    b.max_bounty_out_bps = args.max_bounty_out_bps;
    b.self_hosted_in_cap = args.self_hosted_in_cap;
    b.window_s = args.window_s;
    b.min_ttl_s = args.min_ttl_s;
    b.max_ttl_s = args.max_ttl_s;
    b.refund_grace_s = args.refund_grace_s;
    b.min_amount = args.min_amount;
    b.paused = args.paused;
    b.bump = ctx.bumps.bounty_config;
    emit!(BountyConfigSet { args });
    Ok(())
}

/// The signer allowed to act for a payer agent: the hosted runtime if hosted, otherwise the agent's
/// current registry owner (the launcher until a `propose_owner` / `accept_owner` transfer; audit
/// A1-03: `AgentLaunch.launcher` is fixed at launch and kept the seller in control after a sale).
fn check_opener(c: &LaunchConfig, payer: &AgentLaunch, record: &units_registry::Agent, opener: &Pubkey) -> Result<()> {
    require_keys_eq!(record.agent, payer.agent, LaunchError::Unauthorized);
    let want = if payer.hosted { c.runtime_authority } else { record.owner };
    require_keys_eq!(*opener, want, LaunchError::Unauthorized);
    Ok(())
}

fn window(now: i64, window_s: u32) -> u64 {
    (now.max(0) as u64) / (window_s.max(1) as u64)
}

pub(crate) fn open_bounty(ctx: Context<OpenBounty>, args: OpenBountyArgs) -> Result<()> {
    let c = &ctx.accounts.launch_config;
    let bc = &ctx.accounts.bounty_config;
    require!(!c.paused && !bc.paused, LaunchError::Paused);
    let payer = &ctx.accounts.payer_launch;
    check_opener(c, payer, &ctx.accounts.payer_record, &ctx.accounts.opener.key())?;
    let now = Clock::get()?.unix_timestamp;
    require!(args.amount > 0 && args.amount >= bc.min_amount, LaunchError::InvalidArgs);
    let ttl = args.deadline.checked_sub(now).ok_or(LaunchError::InvalidArgs)?;
    require!(ttl >= bc.min_ttl_s as i64 && ttl <= bc.max_ttl_s as i64, LaunchError::BountyTtl);
    require!(args.condition_kind <= COND_TARGET && args.lineage_id != [0u8; 32], LaunchError::InvalidArgs);
    require!(args.condition_kind != COND_COMMITMENT || args.condition_value != [0u8; 32], LaunchError::InvalidArgs);
    require!(args.payee != payer.agent, LaunchError::InvalidArgs);

    // Cap: what one agent escrows in a window is at most max_bounty_out_bps of its compute vault
    // balance at the first open of that window.
    let balance = ctx.accounts.payer_compute.amount;
    let w = window(now, bc.window_s);
    let led = &mut ctx.accounts.payer_ledger;
    if led.agent == Pubkey::default() {
        led.agent = payer.agent;
        led.bump = ctx.bumps.payer_ledger;
    }
    if led.out_window != w || (led.out_base == 0 && led.out_amount == 0) {
        led.out_window = w;
        led.out_base = balance;
        led.out_amount = 0;
    }
    let out = led.out_amount.checked_add(args.amount).ok_or(LaunchError::InvalidArgs)?;
    require!((out as u128) * (BPS as u128) <= (led.out_base as u128) * (bc.max_bounty_out_bps as u128), LaunchError::BountyCap);
    led.out_amount = out;
    led.opened_total = led.opened_total.saturating_add(args.amount);

    let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[c.authority_bump]];
    token_interface::transfer_checked(
        CpiContext::new_with_signer(ctx.accounts.line_token_program.to_account_info(), TransferChecked {
            from: ctx.accounts.payer_compute.to_account_info(),
            mint: ctx.accounts.line_mint.to_account_info(),
            to: ctx.accounts.bounty_vault.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        }, &[seeds]),
        args.amount,
        ctx.accounts.line_mint.decimals,
    )?;
    ctx.accounts.payer_compute.reload()?;
    let rc = &ctx.accounts.registry_config;
    let b = &mut ctx.accounts.bounty;
    b.payer = payer.agent;
    b.bounty_id = args.bounty_id;
    b.payee = args.payee;
    b.opener = ctx.accounts.opener.key();
    b.amount = args.amount;
    b.terms_digest = args.terms_digest;
    b.condition_kind = args.condition_kind;
    b.lineage_id = args.lineage_id;
    b.condition_value = args.condition_value;
    b.min_epoch = if rc.epochs_posted == 0 { 0 } else { rc.last_epoch + 1 };
    b.epochs_posted_at_open = rc.epochs_posted;
    b.deadline = args.deadline;
    b.created_at = now;
    b.status = STATUS_OPEN;
    b.released_to = Pubkey::default();
    b.released_epoch = 0;
    b.leaf = [0u8; 32];
    b.closed_at = 0;
    b.bump = ctx.bumps.bounty;
    b.vault_bump = ctx.bumps.bounty_vault;
    let l = &mut ctx.accounts.payer_launch;
    update_awake(l, ctx.accounts.payer_compute.amount, c);
    emit!(BountyOpened { bounty: b.key(), payer: b.payer, bounty_id: b.bounty_id, payee: b.payee, amount: b.amount, terms_digest: b.terms_digest,
        condition_kind: b.condition_kind, lineage_id: b.lineage_id, condition_value: b.condition_value, min_epoch: b.min_epoch, deadline: b.deadline });
    Ok(())
}

/// Moves the whole vault balance to `to` and closes the vault, its rent back to the opener. The
/// balance, not the escrowed amount: anyone can send tokens into the vault, and a closing balance
/// above zero would make the token program refuse the close and freeze the escrow (audit A1-01).
/// A donation follows the escrow.
fn drain<'info>(c: &LaunchConfig, vault: &InterfaceAccount<'info, TokenAccount>, to: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>, token_program: &Interface<'info, TokenInterface>, authority: &AccountInfo<'info>,
    rent_to: &AccountInfo<'info>) -> Result<()> {
    let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[c.authority_bump]];
    let amount = vault.amount;
    if amount > 0 {
        token_interface::transfer_checked(
            CpiContext::new_with_signer(token_program.to_account_info(), TransferChecked {
                from: vault.to_account_info(),
                mint: mint.to_account_info(),
                to: to.to_account_info(),
                authority: authority.clone(),
            }, &[seeds]),
            amount,
            mint.decimals,
        )?;
    }
    token_interface::close_account(CpiContext::new_with_signer(token_program.to_account_info(), CloseAccount {
        account: vault.to_account_info(),
        destination: rent_to.clone(),
        authority: authority.clone(),
    }, &[seeds]))
}

pub(crate) fn release_bounty(ctx: Context<ReleaseBounty>, args: ReleaseArgs) -> Result<()> {
    let c = &ctx.accounts.launch_config;
    require!(!c.paused && !ctx.accounts.bounty_config.paused, LaunchError::Paused);
    let b = &ctx.accounts.bounty;
    require!(b.status == STATUS_OPEN, LaunchError::BountyClosed);
    require!(args.proof.len() <= MAX_PROOF, LaunchError::InvalidArgs);
    let ep = &ctx.accounts.registry_epoch;
    // The epoch account is the registry's own PDA for `args.epoch` (owner and seeds checked by the
    // account constraints), so its record_root is what Core posted.
    require!(ep.epoch == args.epoch && ep.record_root != [0u8; 32], LaunchError::BadProof);
    require!(args.epoch >= b.min_epoch, LaunchError::BountyCondition);
    require!(ep.posted_at <= b.deadline, LaunchError::BountyCondition);
    // The registry's payout hold applies to record roots too (audit A1-04): nothing is released on an
    // epoch inside its challenge window or while a challenge on it is open, so a root an upheld
    // challenge corrects has paid nothing.
    units_registry::challenge::check_claim_hold(&ctx.accounts.challenge_config.to_account_info(), &ctx.accounts.challenge_gate.to_account_info(),
        ep, Clock::get()?.unix_timestamp).map_err(|_| error!(LaunchError::BountyHeld))?;
    // Condition.
    require!(args.lineage_id == b.lineage_id, LaunchError::BountyCondition);
    let tj = target_json(&args.target, args.target_is_list).ok_or(LaunchError::InvalidArgs)?;
    match b.condition_kind {
        COND_COMMITMENT => require!(args.candidate_commitment == b.condition_value, LaunchError::BountyCondition),
        _ => require!(b.condition_value == [0u8; 32] || target_digest(&tj) == b.condition_value, LaunchError::BountyCondition),
    }
    // Payee: a named payee must be credited in any role (or be the finder); an open bounty pays a
    // member credited as author.
    let payee = ctx.accounts.payee_launch.agent;
    require!(payee != b.payer, LaunchError::BountyPayee);
    let credited = if b.payee != Pubkey::default() {
        payee == b.payee && (args.members.iter().any(|m| m.agent == payee) || args.finder == Some(payee))
    } else {
        args.members.iter().any(|m| m.agent == payee && m.role == ROLE_AUTHOR)
    };
    require!(credited, LaunchError::BountyPayee);
    // Proof.
    let leaf_h = contribution_leaf(args.epoch, &args.gen_id, &args.lineage_id, &tj, &args.candidate_commitment, &args.members, args.finder.as_ref())
        .ok_or(LaunchError::InvalidArgs)?;
    require!(leaf::verify_proof(&leaf_h, &args.proof, &ep.record_root), LaunchError::BadProof);
    // The receipt PDA is keyed by the leaf the caller named (and the payer): it must be this one.
    require!(leaf_h == args.leaf, LaunchError::BadProof);

    // Self-hosted payees: their vault is withdrawable, so what they receive per window is capped
    // (0 = self-hosted payees are not paid).
    let now = Clock::get()?.unix_timestamp;
    let bc = &ctx.accounts.bounty_config;
    let led = &mut ctx.accounts.payee_ledger;
    if led.agent == Pubkey::default() {
        led.agent = payee;
        led.bump = ctx.bumps.payee_ledger;
    }
    if !ctx.accounts.payee_launch.hosted {
        let w = window(now, bc.window_s);
        if led.in_window != w {
            led.in_window = w;
            led.in_amount = 0;
        }
        let inn = led.in_amount.checked_add(b.amount).ok_or(LaunchError::InvalidArgs)?;
        require!(inn <= bc.self_hosted_in_cap, LaunchError::SelfHostedCap);
        led.in_amount = inn;
    }
    led.received_total = led.received_total.saturating_add(b.amount);

    let amount = b.amount;
    drain(c, &ctx.accounts.bounty_vault, &ctx.accounts.payee_compute, &ctx.accounts.line_mint, &ctx.accounts.line_token_program,
        &ctx.accounts.authority.to_account_info(), &ctx.accounts.opener.to_account_info())?;
    ctx.accounts.payee_compute.reload()?;
    let r = &mut ctx.accounts.receipt;
    r.bounty = ctx.accounts.bounty.key();
    r.payer = ctx.accounts.bounty.payer;
    r.leaf = leaf_h;
    r.epoch = args.epoch;
    r.gen_id = args.gen_id;
    r.payee = payee;
    r.amount = amount;
    r.released_at = now;
    let b = &mut ctx.accounts.bounty;
    b.status = STATUS_RELEASED;
    b.released_to = payee;
    b.released_epoch = args.epoch;
    b.leaf = leaf_h;
    b.closed_at = now;
    let l = &mut ctx.accounts.payee_launch;
    update_awake(l, ctx.accounts.payee_compute.amount, c);
    emit!(BountyReleased { bounty: b.key(), payer: b.payer, payee, amount, epoch: args.epoch, gen_id: args.gen_id, leaf: leaf_h });
    Ok(())
}

/// Shared by refund and cancel: the escrow back to the payer's compute vault.
fn give_back<'info>(a: &mut RefundBounty<'info>, status: u8) -> Result<()> {
    let c = &a.launch_config;
    let amount = a.bounty.amount;
    drain(c, &a.bounty_vault, &a.payer_compute, &a.line_mint, &a.line_token_program, &a.authority.to_account_info(), &a.opener.to_account_info())?;
    a.payer_compute.reload()?;
    let now = Clock::get()?.unix_timestamp;
    let b = &mut a.bounty;
    b.status = status;
    b.closed_at = now;
    update_awake(&mut a.payer_launch, a.payer_compute.amount, c);
    emit!(BountyRefunded { bounty: b.key(), payer: b.payer, amount, cancelled: status == STATUS_CANCELLED });
    Ok(())
}

pub(crate) fn refund_bounty(ctx: Context<RefundBounty>) -> Result<()> {
    require!(ctx.accounts.bounty.status == STATUS_OPEN, LaunchError::BountyClosed);
    let now = Clock::get()?.unix_timestamp;
    let due = ctx.accounts.bounty.deadline.saturating_add(ctx.accounts.bounty_config.refund_grace_s as i64);
    require!(now > due, LaunchError::BountyNotExpired);
    give_back(ctx.accounts, STATUS_REFUNDED)
}

pub(crate) fn cancel_bounty(ctx: Context<CancelBounty>) -> Result<()> {
    let a = &mut ctx.accounts.r;
    require!(a.bounty.status == STATUS_OPEN, LaunchError::BountyClosed);
    check_opener(&a.launch_config, &a.payer_launch, &ctx.accounts.payer_record, &ctx.accounts.signer.key())?;
    // Only while no epoch that could hold a qualifying generation exists: once Core posts the
    // next epoch, a payee may have done the work and the escrow stays until release or expiry.
    require!(ctx.accounts.registry_config.epochs_posted == a.bounty.epochs_posted_at_open, LaunchError::BountyLocked);
    give_back(a, STATUS_CANCELLED)
}

// ---------- state ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct BountyConfigArgs {
    /// Most an agent escrows per window, in bps of its compute vault at the window's first open (0 = no bounties).
    pub max_bounty_out_bps: u16,
    /// Most a self-hosted payee receives per window (0 = self-hosted payees are not paid).
    pub self_hosted_in_cap: u64,
    pub window_s: u32,
    pub min_ttl_s: u32,
    pub max_ttl_s: u32,
    /// After the deadline, how long a qualifying release still has before anyone may refund.
    pub refund_grace_s: u32,
    pub min_amount: u64,
    pub paused: bool,
}
impl BountyConfigArgs {
    fn validate(&self) -> Result<()> {
        require!(self.max_bounty_out_bps as u64 <= BPS && self.window_s > 0 && self.max_ttl_s > 0 && self.min_ttl_s <= self.max_ttl_s,
            LaunchError::InvalidArgs);
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct BountyConfig {
    pub max_bounty_out_bps: u16,
    pub self_hosted_in_cap: u64,
    pub window_s: u32,
    pub min_ttl_s: u32,
    pub max_ttl_s: u32,
    pub refund_grace_s: u32,
    pub min_amount: u64,
    pub paused: bool,
    pub bump: u8,
    pub reserved: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct Bounty {
    /// The paying agent (its compute vault funds the escrow and takes refunds).
    pub payer: Pubkey,
    pub bounty_id: u64,
    /// The agent to pay, or default for any agent credited as author.
    pub payee: Pubkey,
    /// Who opened it (launcher or runtime authority); vault rent returns here.
    pub opener: Pubkey,
    pub amount: u64,
    /// sha256 of the canonical terms JSON Core stores.
    pub terms_digest: [u8; 32],
    pub condition_kind: u8,
    pub lineage_id: [u8; 32],
    pub condition_value: [u8; 32],
    /// Only generations in epochs from here on qualify (the registry's next epoch at open).
    pub min_epoch: u64,
    /// The registry's `epochs_posted` at open; cancel needs it unchanged.
    pub epochs_posted_at_open: u64,
    pub deadline: i64,
    pub created_at: i64,
    pub status: u8,
    pub released_to: Pubkey,
    pub released_epoch: u64,
    pub leaf: [u8; 32],
    pub closed_at: i64,
    pub bump: u8,
    pub vault_bump: u8,
}

/// Per agent: bounty flows and the per-window caps.
#[account]
#[derive(InitSpace)]
pub struct BountyLedger {
    pub agent: Pubkey,
    pub out_window: u64,
    pub out_base: u64,
    pub out_amount: u64,
    pub in_window: u64,
    pub in_amount: u64,
    pub opened_total: u64,
    pub received_total: u64,
    pub bump: u8,
}

/// One per (payer, contribution leaf): a generation releases at most one bounty of each payer.
#[account]
#[derive(InitSpace)]
pub struct BountyReceipt {
    pub bounty: Pubkey,
    pub payer: Pubkey,
    pub leaf: [u8; 32],
    pub epoch: u64,
    pub gen_id: [u8; 32],
    pub payee: Pubkey,
    pub amount: u64,
    pub released_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct OpenBountyArgs {
    pub bounty_id: u64,
    pub payee: Pubkey,
    pub amount: u64,
    pub terms_digest: [u8; 32],
    pub condition_kind: u8,
    pub lineage_id: [u8; 32],
    pub condition_value: [u8; 32],
    pub deadline: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ReleaseArgs {
    /// The contribution leaf (recomputed and compared; it keys the receipt PDA).
    pub leaf: [u8; 32],
    pub epoch: u64,
    pub gen_id: [u8; 32],
    pub lineage_id: [u8; 32],
    pub candidate_commitment: [u8; 32],
    pub target: Vec<String>,
    pub target_is_list: bool,
    pub members: Vec<MemberArg>,
    pub finder: Option<Pubkey>,
    pub proof: Vec<[u8; 32]>,
}

// ---------- accounts ----------

#[derive(Accounts)]
pub struct SetBountyConfig<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = admin @ LaunchError::Unauthorized)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(init_if_needed, payer = admin, space = 8 + BountyConfig::INIT_SPACE, seeds = [BOUNTY_CONFIG_SEED], bump)]
    pub bounty_config: Box<Account<'info, BountyConfig>>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: OpenBountyArgs)]
pub struct OpenBounty<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = line_mint)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(seeds = [BOUNTY_CONFIG_SEED], bump = bounty_config.bump)]
    pub bounty_config: Box<Account<'info, BountyConfig>>,
    /// The registry's Config: its epoch cursor sets `min_epoch`.
    #[account(seeds = [units_registry::CONFIG_SEED], bump = registry_config.bump, seeds::program = units_registry::ID)]
    pub registry_config: Box<Account<'info, units_registry::Config>>,
    /// Launcher (self-hosted payer) or runtime authority (hosted payer); pays the rent.
    #[account(mut)]
    pub opener: Signer<'info>,
    /// CHECK: PDA signer.
    #[account(seeds = [AUTHORITY_SEED], bump = launch_config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [AGENT_LAUNCH_SEED, payer_launch.mint.as_ref()], bump = payer_launch.bump)]
    pub payer_launch: Box<Account<'info, AgentLaunch>>,
    #[account(mut, seeds = [COMPUTE_SEED, payer_launch.agent.as_ref()], bump = payer_launch.compute_bump)]
    pub payer_compute: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = opener, space = 8 + BountyLedger::INIT_SPACE, seeds = [BOUNTY_LEDGER_SEED, payer_launch.agent.as_ref()], bump)]
    pub payer_ledger: Box<Account<'info, BountyLedger>>,
    #[account(init, payer = opener, space = 8 + Bounty::INIT_SPACE,
        seeds = [BOUNTY_SEED, payer_launch.agent.as_ref(), &args.bounty_id.to_le_bytes()], bump)]
    pub bounty: Box<Account<'info, Bounty>>,
    #[account(init, payer = opener, seeds = [BOUNTY_VAULT_SEED, bounty.key().as_ref()], bump, token::mint = line_mint, token::authority = authority,
        token::token_program = line_token_program)]
    pub bounty_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = line_token_program)]
    pub line_mint: Box<InterfaceAccount<'info, Mint>>,
    pub line_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    /// The payer's registry `Agent`: a self-hosted payer's opener is its current `owner` (audit A1-03).
    #[account(seeds = [units_registry::AGENT_SEED, payer_launch.agent.as_ref()], bump = payer_record.bump, seeds::program = units_registry::ID)]
    pub payer_record: Box<Account<'info, units_registry::Agent>>,
}

#[derive(Accounts)]
#[instruction(args: ReleaseArgs)]
pub struct ReleaseBounty<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = line_mint)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(seeds = [BOUNTY_CONFIG_SEED], bump = bounty_config.bump)]
    pub bounty_config: Box<Account<'info, BountyConfig>>,
    /// Anyone; pays the receipt (and the payee ledger the first time).
    #[account(mut)]
    pub caller: Signer<'info>,
    /// CHECK: PDA signer.
    #[account(seeds = [AUTHORITY_SEED], bump = launch_config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [BOUNTY_SEED, bounty.payer.as_ref(), &bounty.bounty_id.to_le_bytes()], bump = bounty.bump, has_one = opener)]
    pub bounty: Box<Account<'info, Bounty>>,
    #[account(mut, seeds = [BOUNTY_VAULT_SEED, bounty.key().as_ref()], bump = bounty.vault_bump)]
    pub bounty_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the bounty's opener (has_one); receives the vault rent.
    #[account(mut)]
    pub opener: UncheckedAccount<'info>,
    /// The registry's Epoch for `args.epoch` (owner = registry via the account type, address = its PDA).
    #[account(seeds = [units_registry::EPOCH_SEED, &args.epoch.to_le_bytes()], bump = registry_epoch.bump, seeds::program = units_registry::ID)]
    pub registry_epoch: Box<Account<'info, units_registry::Epoch>>,
    #[account(mut, seeds = [AGENT_LAUNCH_SEED, payee_launch.mint.as_ref()], bump = payee_launch.bump)]
    pub payee_launch: Box<Account<'info, AgentLaunch>>,
    #[account(mut, seeds = [COMPUTE_SEED, payee_launch.agent.as_ref()], bump = payee_launch.compute_bump)]
    pub payee_compute: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init_if_needed, payer = caller, space = 8 + BountyLedger::INIT_SPACE, seeds = [BOUNTY_LEDGER_SEED, payee_launch.agent.as_ref()], bump)]
    pub payee_ledger: Box<Account<'info, BountyLedger>>,
    /// One per (payer, leaf): an existing receipt makes `init` fail. The handler checks that
    /// `args.leaf` is the leaf it recomputes.
    #[account(init, payer = caller, space = 8 + BountyReceipt::INIT_SPACE, seeds = [BOUNTY_RECEIPT_SEED, bounty.payer.as_ref(), &args.leaf], bump)]
    pub receipt: Box<Account<'info, BountyReceipt>>,
    #[account(mint::token_program = line_token_program)]
    pub line_mint: Box<InterfaceAccount<'info, Mint>>,
    pub line_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    /// CHECK: the registry's `ChallengeConfig` PDA, read only if it exists (audit A1-04: a release
    /// waits for the epoch's challenge window, as a claim does).
    #[account(seeds = [units_registry::CHALLENGE_CONFIG_SEED], bump, seeds::program = units_registry::ID)]
    pub challenge_config: UncheckedAccount<'info>,
    /// CHECK: the registry's `ChallengeGate` PDA of `args.epoch`, read only if it exists (no release
    /// while a challenge on the epoch is open).
    #[account(seeds = [units_registry::GATE_SEED, &args.epoch.to_le_bytes()], bump, seeds::program = units_registry::ID)]
    pub challenge_gate: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct RefundBounty<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = line_mint)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(seeds = [BOUNTY_CONFIG_SEED], bump = bounty_config.bump)]
    pub bounty_config: Box<Account<'info, BountyConfig>>,
    /// CHECK: PDA signer.
    #[account(seeds = [AUTHORITY_SEED], bump = launch_config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [BOUNTY_SEED, bounty.payer.as_ref(), &bounty.bounty_id.to_le_bytes()], bump = bounty.bump, has_one = opener)]
    pub bounty: Box<Account<'info, Bounty>>,
    #[account(mut, seeds = [BOUNTY_VAULT_SEED, bounty.key().as_ref()], bump = bounty.vault_bump)]
    pub bounty_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the bounty's opener (has_one); receives the vault rent.
    #[account(mut)]
    pub opener: UncheckedAccount<'info>,
    #[account(mut, seeds = [AGENT_LAUNCH_SEED, payer_launch.mint.as_ref()], bump = payer_launch.bump,
        constraint = payer_launch.agent == bounty.payer @ LaunchError::InvalidArgs)]
    pub payer_launch: Box<Account<'info, AgentLaunch>>,
    #[account(mut, seeds = [COMPUTE_SEED, bounty.payer.as_ref()], bump = payer_launch.compute_bump)]
    pub payer_compute: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = line_token_program)]
    pub line_mint: Box<InterfaceAccount<'info, Mint>>,
    pub line_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct CancelBounty<'info> {
    pub r: RefundBounty<'info>,
    #[account(seeds = [units_registry::CONFIG_SEED], bump = registry_config.bump, seeds::program = units_registry::ID)]
    pub registry_config: Box<Account<'info, units_registry::Config>>,
    /// The payer's current registry owner (self-hosted) or the runtime authority (hosted).
    pub signer: Signer<'info>,
    /// The payer's registry `Agent` (audit A1-03).
    #[account(seeds = [units_registry::AGENT_SEED, r.bounty.payer.as_ref()], bump = payer_record.bump, seeds::program = units_registry::ID)]
    pub payer_record: Box<Account<'info, units_registry::Agent>>,
}

// ---------- events ----------

#[event]
pub struct BountyConfigSet {
    pub args: BountyConfigArgs,
}
#[event]
pub struct BountyOpened {
    pub bounty: Pubkey,
    pub payer: Pubkey,
    pub bounty_id: u64,
    pub payee: Pubkey,
    pub amount: u64,
    pub terms_digest: [u8; 32],
    pub condition_kind: u8,
    pub lineage_id: [u8; 32],
    pub condition_value: [u8; 32],
    pub min_epoch: u64,
    pub deadline: i64,
}
#[event]
pub struct BountyReleased {
    pub bounty: Pubkey,
    pub payer: Pubkey,
    pub payee: Pubkey,
    pub amount: u64,
    pub epoch: u64,
    pub gen_id: [u8; 32],
    pub leaf: [u8; 32],
}
#[event]
pub struct BountyRefunded {
    pub bounty: Pubkey,
    pub payer: Pubkey,
    pub amount: u64,
    pub cancelled: bool,
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
    }
}
