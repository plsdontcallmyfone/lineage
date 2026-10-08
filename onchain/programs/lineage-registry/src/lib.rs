//! `lineage_registry` (SPEC 14.1): agent identities, burns, bonds, slashing, the treasury split
//! and epoch payouts by Merkle claim. Token-interface based: `$LINE` may be an SPL Token or a
//! Token-2022 mint.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface, TransferChecked};

pub mod challenge;
pub mod leaf;

pub use challenge::*;

declare_id!("2vhj9aBZkuoCpmJxm5BcA3CYkvBJgY6VHTax8FpFmxuY");

pub const CONFIG_SEED: &[u8] = b"config";
pub const VAULT_AUTHORITY_SEED: &[u8] = b"vault_authority";
pub const BOND_VAULT_SEED: &[u8] = b"bond_vault";
pub const TREASURY_SEED: &[u8] = b"treasury";
pub const RESERVE_SEED: &[u8] = b"reserve";
pub const POOL_SEED: &[u8] = b"pool";
pub const PAYABLE_SEED: &[u8] = b"payable";
pub const AGENT_SEED: &[u8] = b"agent";
pub const EPOCH_SEED: &[u8] = b"epoch";
pub const CLAIM_SEED: &[u8] = b"claim";
pub const SLASH_SEED: &[u8] = b"slash";
/// Seeds of `lineage_launch`'s signer PDA; `register_launched` requires it as a signer.
pub const LAUNCH_AUTHORITY_SEED: &[u8] = b"authority";
/// Seeds of `lineage_launch`'s compute vault for an agent: ["compute", agent].
pub const COMPUTE_SEED: &[u8] = b"compute";

pub const BPS: u64 = 10_000;
pub const KIND_VERIFIER: u8 = 0;
pub const KIND_LAUNCHED: u8 = 1;
pub const OFFENCE_CANARY: u8 = 0;
pub const OFFENCE_MINORITY: u8 = 1;
pub const OFFENCE_REVEAL: u8 = 2;
pub const OFFENCE_ABANDON: u8 = 3;
pub const MAX_PROOF: usize = 32;

#[program]
pub mod lineage_registry {
    use super::*;

    /// Once, by the program's upgrade authority (checked through ProgramData, so nobody can
    /// front-run the deploy): creates Config and the five vaults.
    pub fn initialize(ctx: Context<Initialize>, args: ConfigArgs) -> Result<()> {
        args.validate()?;
        check_mint_extensions(&ctx.accounts.mint.to_account_info())?;
        let c = &mut ctx.accounts.config;
        c.admin = args.admin;
        c.core_authority = args.core_authority;
        c.launch_program = args.launch_program;
        c.mint = ctx.accounts.mint.key();
        c.token_program = ctx.accounts.token_program.key();
        c.params = args.params;
        c.paused = false;
        c.epochs_posted = 0;
        c.last_epoch = 0;
        c.bump = ctx.bumps.config;
        c.vault_authority_bump = ctx.bumps.vault_authority;
        c.max_rebate_per_epoch = args.max_rebate_per_epoch;
        c.epoch_anchor = 0;
        c.epoch_anchor_ts = 0;
        emit!(ConfigSet { admin: c.admin, core_authority: c.core_authority, launch_program: c.launch_program, params: c.params });
        Ok(())
    }

    /// Admin: every parameter, the admin, the Core authority and the launch program. The mint is
    /// fixed at initialize because the vaults are bound to it.
    pub fn set_config(ctx: Context<AdminOnly>, args: ConfigArgs) -> Result<()> {
        args.validate()?;
        let c = &mut ctx.accounts.config;
        c.admin = args.admin;
        c.core_authority = args.core_authority;
        c.launch_program = args.launch_program;
        c.params = args.params;
        c.max_rebate_per_epoch = args.max_rebate_per_epoch;
        emit!(ConfigSet { admin: c.admin, core_authority: c.core_authority, launch_program: c.launch_program, params: c.params });
        Ok(())
    }

    /// Admin: stops every instruction but `set_config` and `pause`.
    pub fn pause(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        emit!(Paused { paused });
        Ok(())
    }

    /// Admin escape hatch for the epoch sequence `post_epoch` enforces: the number of epochs
    /// posted, the last one, and the clock anchor (epoch `anchor` was posted at `anchor_ts`).
    /// Used to repair a sequence a compromised or misconfigured Core authority advanced.
    pub fn set_epoch_cursor(ctx: Context<AdminOnly>, epochs_posted: u64, last_epoch: u64, anchor: u64, anchor_ts: i64) -> Result<()> {
        require!(anchor <= last_epoch || epochs_posted == 0, RegistryError::InvalidParams);
        let c = &mut ctx.accounts.config;
        c.epochs_posted = epochs_posted;
        c.last_epoch = last_epoch;
        c.epoch_anchor = anchor;
        c.epoch_anchor_ts = anchor_ts;
        emit!(EpochCursorSet { epochs_posted, last_epoch, anchor, anchor_ts });
        Ok(())
    }

    /// Admin, once per layout change: grows a `Config` written by the first deployed layout (no
    /// rebate cap, no epoch anchor) to the current one. The anchor starts at the last posted
    /// epoch and now. The admin pays the added rent.
    pub fn migrate_config(ctx: Context<MigrateConfig>, max_rebate_per_epoch: u64) -> Result<()> {
        let info = ctx.accounts.config.to_account_info();
        let new_len = 8 + Config::INIT_SPACE;
        require!(info.data_len() == new_len - CONFIG_V1_TAIL, RegistryError::InvalidParams);
        {
            let d = info.try_borrow_data()?;
            require!(d[..8] == *Config::DISCRIMINATOR, RegistryError::InvalidParams);
            require!(d[8..40] == ctx.accounts.admin.key().to_bytes(), RegistryError::Unauthorized);
        }
        grow(&info, &ctx.accounts.admin.to_account_info(), &ctx.accounts.system_program.to_account_info(), new_len)?;
        let mut c = Config::try_deserialize(&mut &info.try_borrow_data()?[..])?;
        c.max_rebate_per_epoch = max_rebate_per_epoch;
        c.epoch_anchor = c.last_epoch;
        c.epoch_anchor_ts = Clock::get()?.unix_timestamp;
        c.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])?;
        emit!(EpochCursorSet { epochs_posted: c.epochs_posted, last_epoch: c.last_epoch, anchor: c.epoch_anchor, anchor_ts: c.epoch_anchor_ts });
        Ok(())
    }

    /// A tokenless verifier: the owner burns `register_burn` and the agent key co-signs (proves
    /// it holds the key Core will see on signed requests).
    pub fn register(ctx: Context<Register>, operator: [u8; 32], capabilities: [u8; 32]) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.paused, RegistryError::Paused);
        let amount = c.params.register_burn;
        if amount > 0 {
            token_interface::burn(
                CpiContext::new(ctx.accounts.token_program.to_account_info(), Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.owner_token.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                }),
                amount,
            )?;
        }
        let a = &mut ctx.accounts.agent_record;
        init_agent(a, ctx.accounts.agent.key(), ctx.accounts.owner.key(), KIND_VERIFIER, Pubkey::default(), false, operator, capabilities,
            ctx.bumps.agent_record)?;
        a.burned = amount;
        emit!(Registered { agent: a.agent, owner: a.owner, kind: KIND_VERIFIER, mint: Pubkey::default(), burned: amount, hosted: false });
        Ok(())
    }

    /// Only through `lineage_launch::launch_agent`: its authority PDA must sign.
    pub fn register_launched(ctx: Context<RegisterLaunched>, args: RegisterLaunchedArgs) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.paused, RegistryError::Paused);
        let expected = Pubkey::find_program_address(&[LAUNCH_AUTHORITY_SEED], &c.launch_program).0;
        require_keys_eq!(ctx.accounts.launch_authority.key(), expected, RegistryError::NotLaunchProgram);
        let a = &mut ctx.accounts.agent_record;
        init_agent(a, args.agent, args.owner, KIND_LAUNCHED, args.mint, args.hosted, [0; 32], [0; 32], ctx.bumps.agent_record)?;
        emit!(Registered { agent: a.agent, owner: a.owner, kind: KIND_LAUNCHED, mint: a.mint, burned: 0, hosted: a.hosted });
        Ok(())
    }

    /// Owner: declared operator group and capabilities digest (SPEC 6.1, 10.3).
    pub fn update_agent(ctx: Context<OwnerAgent>, operator: [u8; 32], capabilities: [u8; 32]) -> Result<()> {
        require!(!ctx.accounts.config.paused, RegistryError::Paused);
        let a = &mut ctx.accounts.agent_record;
        a.operator = operator;
        a.capabilities = capabilities;
        Ok(())
    }

    /// Owner: locks `amount` more in the bond vault. Hosted agents never bond (they never verify).
    pub fn bond(ctx: Context<BondCtx>, amount: u64) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.paused, RegistryError::Paused);
        require!(amount > 0, RegistryError::ZeroAmount);
        require!(!ctx.accounts.agent_record.hosted, RegistryError::Hosted);
        let decimals = ctx.accounts.mint.decimals;
        token_interface::transfer_checked(
            CpiContext::new(ctx.accounts.token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.owner_token.to_account_info(),
                mint: ctx.accounts.mint.to_account_info(),
                to: ctx.accounts.bond_vault.to_account_info(),
                authority: ctx.accounts.owner.to_account_info(),
            }),
            amount,
            decimals,
        )?;
        let a = &mut ctx.accounts.agent_record;
        a.bond = a.bond.checked_add(amount).ok_or(RegistryError::Overflow)?;
        emit!(Bonded { agent: a.agent, amount, bond: a.bond });
        Ok(())
    }

    /// Owner: starts the cooldown for `amount` (replaces any pending request). The bond stays
    /// slashable until it is withdrawn.
    pub fn request_unbond(ctx: Context<OwnerAgent>, amount: u64) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.paused, RegistryError::Paused);
        let a = &mut ctx.accounts.agent_record;
        require!(amount > 0 && amount <= a.bond, RegistryError::InvalidAmount);
        let now = Clock::get()?.unix_timestamp;
        a.unbond_amount = amount;
        a.unbond_requested_at = now;
        a.unbond_ready_at = now.checked_add(c.params.unbond_cooldown_s).ok_or(RegistryError::Overflow)?;
        emit!(UnbondRequested { agent: a.agent, amount, ready_at: a.unbond_ready_at });
        Ok(())
    }

    /// Owner, after the cooldown: `min(requested, bond)` back to the owner.
    pub fn withdraw_unbonded(ctx: Context<WithdrawUnbonded>) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.paused, RegistryError::Paused);
        let a = &ctx.accounts.agent_record;
        require!(a.unbond_amount > 0, RegistryError::NoUnbond);
        require!(Clock::get()?.unix_timestamp >= a.unbond_ready_at, RegistryError::Cooldown);
        let amount = a.unbond_amount.min(a.bond);
        let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &[c.vault_authority_bump]];
        if amount > 0 {
            vault_transfer(&ctx.accounts.token_program, &ctx.accounts.bond_vault, &ctx.accounts.mint, &ctx.accounts.owner_token,
                &ctx.accounts.vault_authority, seeds, amount)?;
        }
        let a = &mut ctx.accounts.agent_record;
        a.bond -= amount;
        a.unbond_amount = 0;
        a.unbond_requested_at = 0;
        a.unbond_ready_at = 0;
        emit!(Unbonded { agent: a.agent, amount, bond: a.bond });
        Ok(())
    }

    /// Core authority: the SPEC 13.6 table. The amount is the configured share of the current
    /// bond; slashed tokens go to the compute reserve. Every offence is a strike; reaching
    /// `strike_limit` in one epoch suspends the agent through the next epoch.
    /// `slash_id` is Core's id for this slash (32 bytes); its `SlashReceipt` PDA makes a retried
    /// transaction land at most once.
    pub fn slash(ctx: Context<Slash>, offence: u8, epoch: u64, slash_id: [u8; 32]) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.paused, RegistryError::Paused);
        let bps = match offence {
            OFFENCE_CANARY => c.params.canary_slash_bps,
            OFFENCE_MINORITY => c.params.minority_slash_bps,
            OFFENCE_REVEAL => c.params.reveal_slash_bps,
            OFFENCE_ABANDON => 0,
            _ => return err!(RegistryError::InvalidParams),
        };
        let bond = ctx.accounts.agent_record.bond;
        let amount = (bond as u128 * bps as u128 / BPS as u128) as u64;
        if amount > 0 {
            let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &[c.vault_authority_bump]];
            vault_transfer(&ctx.accounts.token_program, &ctx.accounts.bond_vault, &ctx.accounts.mint, &ctx.accounts.reserve_vault,
                &ctx.accounts.vault_authority, seeds, amount)?;
        }
        let limit = c.params.strike_limit;
        let a = &mut ctx.accounts.agent_record;
        a.bond -= amount;
        a.unbond_amount = a.unbond_amount.min(a.bond);
        a.slashed_total = a.slashed_total.saturating_add(amount);
        a.strikes_total = a.strikes_total.saturating_add(1);
        // The per-epoch count restarts only for a strictly newer epoch; a late strike for an
        // older epoch counts in the total but never resets or inflates the current epoch's count.
        if epoch > a.strikes_epoch {
            a.strikes_epoch = epoch;
            a.strikes_in_epoch = 0;
        }
        if epoch == a.strikes_epoch {
            a.strikes_in_epoch = a.strikes_in_epoch.saturating_add(1);
            if limit > 0 && a.strikes_in_epoch >= limit {
                a.suspended_through_epoch = a.suspended_through_epoch.max(epoch.saturating_add(1));
            }
        }
        let r = &mut ctx.accounts.slash_receipt;
        r.slash_id = slash_id;
        r.agent = a.agent;
        r.offence = offence;
        r.epoch = epoch;
        r.amount = amount;
        r.slashed_at = Clock::get()?.unix_timestamp;
        emit!(Slashed { agent: a.agent, offence, epoch, amount, bond: a.bond, strikes_in_epoch: a.strikes_in_epoch,
            suspended_through_epoch: a.suspended_through_epoch });
        Ok(())
    }

    /// Anyone: moves the whole treasury balance, `reserve_bps` to the reserve and the rest
    /// (`pool_bps`, which sums with it to 10,000) to the epoch pool.
    pub fn split(ctx: Context<Split>) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.paused, RegistryError::Paused);
        let total = ctx.accounts.treasury.amount;
        require!(total > 0, RegistryError::ZeroAmount);
        let reserve = (total as u128 * c.params.reserve_bps as u128 / BPS as u128) as u64;
        let pool = total - reserve;
        let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &[c.vault_authority_bump]];
        if reserve > 0 {
            vault_transfer(&ctx.accounts.token_program, &ctx.accounts.treasury, &ctx.accounts.mint, &ctx.accounts.reserve_vault,
                &ctx.accounts.vault_authority, seeds, reserve)?;
        }
        if pool > 0 {
            vault_transfer(&ctx.accounts.token_program, &ctx.accounts.treasury, &ctx.accounts.mint, &ctx.accounts.pool_vault,
                &ctx.accounts.vault_authority, seeds, pool)?;
        }
        emit!(SplitDone { total, reserve, pool });
        Ok(())
    }

    /// Core authority, once per epoch, in increasing order: records the roots and totals and
    /// moves `pool_amount` from the pool vault and `rebate_amount` from the reserve into the
    /// payable vault that claims draw from.
    pub fn post_epoch(ctx: Context<PostEpoch>, args: PostEpochArgs) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.paused, RegistryError::Paused);
        let now = Clock::get()?.unix_timestamp;
        // One sequence: the first post sets the anchor, every later one is exactly the next
        // epoch and at most one epoch ahead of the wall clock measured from the anchor.
        if c.epochs_posted > 0 {
            require!(Some(args.epoch) == c.last_epoch.checked_add(1), RegistryError::EpochOrder);
            let ahead = args.epoch.checked_sub(c.epoch_anchor).ok_or(RegistryError::EpochOrder)?.saturating_sub(1);
            let earliest = (ahead as i128) * (c.params.epoch_length_s as i128) + c.epoch_anchor_ts as i128;
            require!(now as i128 >= earliest, RegistryError::EpochTooEarly);
        }
        require!(args.rebate_amount <= c.max_rebate_per_epoch, RegistryError::RebateCap);
        require!(args.pool_amount <= ctx.accounts.pool_vault.amount && args.rebate_amount <= ctx.accounts.reserve_vault.amount,
            RegistryError::InvalidAmount);
        let total = args.pool_amount.checked_add(args.rebate_amount).ok_or(RegistryError::Overflow)?;
        let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &[c.vault_authority_bump]];
        if args.pool_amount > 0 {
            vault_transfer(&ctx.accounts.token_program, &ctx.accounts.pool_vault, &ctx.accounts.mint, &ctx.accounts.payable_vault,
                &ctx.accounts.vault_authority, seeds, args.pool_amount)?;
        }
        if args.rebate_amount > 0 {
            vault_transfer(&ctx.accounts.token_program, &ctx.accounts.reserve_vault, &ctx.accounts.mint, &ctx.accounts.payable_vault,
                &ctx.accounts.vault_authority, seeds, args.rebate_amount)?;
        }
        let e = &mut ctx.accounts.epoch;
        e.epoch = args.epoch;
        e.payout_root = args.payout_root;
        e.lineage_root = args.lineage_root;
        e.record_root = args.record_root;
        e.total_units_micro = args.total_units_micro;
        e.pool_amount = args.pool_amount;
        e.rebate_amount = args.rebate_amount;
        e.total_payable = total;
        e.claimed_amount = 0;
        e.claims = 0;
        e.posted_at = now;
        e.bump = ctx.bumps.epoch;
        let c = &mut ctx.accounts.config;
        if c.epochs_posted == 0 {
            c.epoch_anchor = args.epoch;
            c.epoch_anchor_ts = now;
        }
        c.epochs_posted += 1;
        c.last_epoch = args.epoch;
        emit!(EpochPosted { epoch: args.epoch, payout_root: args.payout_root, lineage_root: args.lineage_root, record_root: args.record_root,
            pool_amount: args.pool_amount, rebate_amount: args.rebate_amount, total_units_micro: args.total_units_micro });
        Ok(())
    }

    /// Owner and the new key (Agent v2, identity plan I1): points the agent at `new_key`. The agent
    /// id never changes; `signing_key` is the key that speaks for it. The new key signs, so nobody
    /// can point an agent at a key they do not hold. Also how a revoked agent is restored.
    pub fn rotate_agent_key(ctx: Context<RotateAgentKey>) -> Result<()> {
        require!(!ctx.accounts.config.paused, RegistryError::Paused);
        let new_key = ctx.accounts.new_key.key();
        require!(new_key != Pubkey::default(), RegistryError::InvalidParams);
        let a = &mut ctx.accounts.agent_record;
        let old = a.signing_key;
        a.signing_key = new_key;
        a.key_seq = a.key_seq.checked_add(1).ok_or(RegistryError::Overflow)?;
        a.key_changed_at = Clock::get()?.unix_timestamp;
        emit!(KeyRotated { agent: a.agent, old, new: new_key, seq: a.key_seq });
        Ok(())
    }

    /// Owner: kill switch for a leaked signing key (`signing_key` = default; Core refuses every
    /// request for the agent until a rotation). Allowed while paused: it only removes power.
    pub fn revoke_agent_key(ctx: Context<OwnerAgent>) -> Result<()> {
        let a = &mut ctx.accounts.agent_record;
        let old = a.signing_key;
        a.signing_key = Pubkey::default();
        a.key_seq = a.key_seq.checked_add(1).ok_or(RegistryError::Overflow)?;
        a.key_changed_at = Clock::get()?.unix_timestamp;
        emit!(KeyRevoked { agent: a.agent, old, seq: a.key_seq });
        Ok(())
    }

    /// The agent's current signing key: sha256 of its canonical profile document (identity plan
    /// 2.3). `seq` must exceed the last one, so an older signed profile cannot be replayed.
    pub fn set_profile(ctx: Context<SetProfile>, digest: [u8; 32], seq: u32) -> Result<()> {
        require!(!ctx.accounts.config.paused, RegistryError::Paused);
        let a = &mut ctx.accounts.agent_record;
        require!(a.signing_key != Pubkey::default(), RegistryError::KeyRevoked);
        require_keys_eq!(ctx.accounts.signing_key.key(), a.signing_key, RegistryError::Unauthorized);
        require!(seq > a.profile_seq, RegistryError::ProfileSeq);
        a.profile_digest = digest;
        a.profile_seq = seq;
        emit!(ProfileSet { agent: a.agent, digest, seq });
        Ok(())
    }

    /// Owner: first step of a public owner transfer (owner decision Q3). `Pubkey::default()`
    /// cancels a pending proposal. Nothing changes until the proposed owner accepts.
    pub fn propose_owner(ctx: Context<OwnerAgent>, new_owner: Pubkey) -> Result<()> {
        require!(!ctx.accounts.config.paused, RegistryError::Paused);
        let a = &mut ctx.accounts.agent_record;
        require!(new_owner != a.owner, RegistryError::InvalidParams);
        a.pending_owner = new_owner;
        emit!(OwnerProposed { agent: a.agent, owner: a.owner, proposed: new_owner });
        Ok(())
    }

    /// The proposed owner: completes the transfer. `owner_since` (the credential's
    /// `controller_since`) restarts now. The bond, its unbond request and `agent:<id>:wallet`
    /// payouts follow the owner; the signing key does not change (the new owner rotates it).
    pub fn accept_owner(ctx: Context<AcceptOwner>) -> Result<()> {
        require!(!ctx.accounts.config.paused, RegistryError::Paused);
        let a = &mut ctx.accounts.agent_record;
        require!(a.pending_owner != Pubkey::default(), RegistryError::NoPendingOwner);
        require_keys_eq!(ctx.accounts.new_owner.key(), a.pending_owner, RegistryError::Unauthorized);
        let old = a.owner;
        a.owner = a.pending_owner;
        a.pending_owner = Pubkey::default();
        a.owner_since = Clock::get()?.unix_timestamp;
        emit!(OwnerChanged { agent: a.agent, old, new: a.owner, at: a.owner_since });
        Ok(())
    }

    /// Anyone (the payer adds the rent): grows an `Agent` written by the first layout to Agent v2,
    /// `signing_key` = the agent key, `owner_since` = `registered_at`. Every instruction that reads
    /// an Agent fails on a v1 record until this runs.
    pub fn migrate_agent(ctx: Context<MigrateAgent>) -> Result<()> {
        let info = ctx.accounts.agent_record.to_account_info();
        let new_len = 8 + Agent::INIT_SPACE;
        require!(info.data_len() == new_len - AGENT_V1_TAIL, RegistryError::InvalidParams);
        {
            let d = info.try_borrow_data()?;
            require!(d[..8] == *Agent::DISCRIMINATOR, RegistryError::InvalidParams);
        }
        grow(&info, &ctx.accounts.payer.to_account_info(), &ctx.accounts.system_program.to_account_info(), new_len)?;
        let mut a = Agent::try_deserialize(&mut &info.try_borrow_data()?[..])?;
        let expected = Pubkey::create_program_address(&[AGENT_SEED, a.agent.as_ref(), &[a.bump]], &crate::ID)
            .map_err(|_| error!(RegistryError::InvalidParams))?;
        require_keys_eq!(expected, info.key(), RegistryError::InvalidParams);
        a.signing_key = a.agent;
        a.key_seq = 0;
        a.key_changed_at = 0;
        a.profile_digest = [0; 32];
        a.profile_seq = 0;
        a.pending_owner = Pubkey::default();
        a.owner_since = a.registered_at;
        a.v2_reserved = [0; 32];
        a.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])?;
        emit!(AgentMigrated { agent: a.agent });
        Ok(())
    }

    /// Anyone (the payer adds the rent): grows an `Epoch` posted before `record_root` existed, with
    /// a zero `record_root` (none), so its claims keep working after the upgrade.
    pub fn migrate_epoch(ctx: Context<MigrateEpoch>) -> Result<()> {
        let info = ctx.accounts.epoch.to_account_info();
        let new_len = 8 + Epoch::INIT_SPACE;
        require!(info.data_len() == new_len - EPOCH_V1_TAIL, RegistryError::InvalidParams);
        {
            let d = info.try_borrow_data()?;
            require!(d[..8] == *Epoch::DISCRIMINATOR, RegistryError::InvalidParams);
        }
        grow(&info, &ctx.accounts.payer.to_account_info(), &ctx.accounts.system_program.to_account_info(), new_len)?;
        let mut e = Epoch::try_deserialize(&mut &info.try_borrow_data()?[..])?;
        let expected = Pubkey::create_program_address(&[EPOCH_SEED, &e.epoch.to_le_bytes(), &[e.bump]], &crate::ID)
            .map_err(|_| error!(RegistryError::InvalidParams))?;
        require_keys_eq!(expected, info.key(), RegistryError::InvalidParams);
        e.record_root = [0; 32];
        e.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])?;
        Ok(())
    }

    /// Anyone (the tokens can only go to the leaf's destination): proves the leaf
    /// `leafHash(canonicalJson({ epoch, agent, dest, amount }))` against the epoch's root and pays
    /// it once. The receipt PDA is keyed by the leaf hash because sorted-pair proofs do not bind a
    /// leaf index, so an index bitmap could be claimed twice under two indices.
    pub fn claim(ctx: Context<Claim>, args: ClaimArgs) -> Result<()> {
        let c = &ctx.accounts.config;
        require!(!c.paused, RegistryError::Paused);
        require!(args.amount > 0 && args.proof.len() <= MAX_PROOF, RegistryError::InvalidAmount);
        let kind = match args.dest_kind {
            0 => leaf::Dest::AgentWallet,
            1 => leaf::Dest::AgentCompute,
            2 => leaf::Dest::Wallet,
            _ => return err!(RegistryError::BadDestination),
        };
        let e = &ctx.accounts.epoch;
        // payouts wait for the epoch's challenge window and for every challenge on it (SPEC 10.8)
        challenge::check_claim_hold(&ctx.accounts.challenge_config.to_account_info(), &ctx.accounts.challenge_gate.to_account_info(), e,
            Clock::get()?.unix_timestamp)?;
        let leaf_h = leaf::payout_leaf(e.epoch, &args.agent.to_bytes(), kind, &args.wallet.to_bytes(), args.amount);
        require!(leaf_h == args.leaf, RegistryError::LeafMismatch);
        require!(leaf::verify_proof(&leaf_h, &args.proof, &e.payout_root), RegistryError::BadProof);
        // The destination token account must be the one the leaf names.
        let dest = &ctx.accounts.dest_token;
        match kind {
            leaf::Dest::AgentWallet => {
                let rec = ctx.accounts.agent_record.as_ref().ok_or(RegistryError::BadDestination)?;
                require_keys_eq!(rec.agent, args.agent, RegistryError::BadDestination);
                require_keys_eq!(dest.owner, rec.owner, RegistryError::BadDestination);
            }
            leaf::Dest::AgentCompute => {
                let vault = Pubkey::find_program_address(&[COMPUTE_SEED, args.agent.as_ref()], &c.launch_program).0;
                require_keys_eq!(dest.key(), vault, RegistryError::BadDestination);
            }
            leaf::Dest::Wallet => require_keys_eq!(dest.owner, args.wallet, RegistryError::BadDestination),
        }
        let claimed = e.claimed_amount.checked_add(args.amount).ok_or(RegistryError::Overflow)?;
        require!(claimed <= e.total_payable, RegistryError::OverClaim);
        let seeds: &[&[u8]] = &[VAULT_AUTHORITY_SEED, &[c.vault_authority_bump]];
        vault_transfer(&ctx.accounts.token_program, &ctx.accounts.payable_vault, &ctx.accounts.mint, dest, &ctx.accounts.vault_authority,
            seeds, args.amount)?;
        let e = &mut ctx.accounts.epoch;
        e.claimed_amount = claimed;
        e.claims += 1;
        let r = &mut ctx.accounts.receipt;
        r.epoch = e.epoch;
        r.leaf = leaf_h;
        r.agent = args.agent;
        r.dest_token = dest.key();
        r.amount = args.amount;
        r.claimed_at = Clock::get()?.unix_timestamp;
        emit!(Claimed { epoch: e.epoch, agent: args.agent, dest_kind: args.dest_kind, dest_token: dest.key(), amount: args.amount, leaf: leaf_h });
        Ok(())
    }

    /// Admin: creates or updates the `ChallengeConfig` and the challenge bond vault (SPEC 10.8).
    pub fn set_challenge_config(ctx: Context<SetChallengeConfig>, args: ChallengeConfigArgs) -> Result<()> {
        challenge::handle_set_config(ctx, args)
    }

    /// A registered agent (its current signing key signs; any payer bonds `bond` `$LINE`): contests a
    /// final verdict, a slash or an epoch root within `window_s` (challenge.rs).
    pub fn open_challenge(ctx: Context<OpenChallenge>, args: OpenChallengeArgs) -> Result<()> {
        challenge::handle_open(ctx, args)
    }

    /// Core authority: records Core's resolution (upheld, failed, void), moves the bond and reward,
    /// reverses a contested slash and may correct a contested epoch's roots before any claim.
    pub fn resolve_challenge(ctx: Context<ResolveChallenge>, args: ResolveChallengeArgs) -> Result<()> {
        challenge::handle_resolve(ctx, args)
    }

    /// Anyone, after `resolve_timeout_s`: an unresolved challenge's bond goes back and its hold ends.
    pub fn expire_challenge(ctx: Context<ExpireChallenge>) -> Result<()> {
        challenge::handle_expire(ctx)
    }
}

#[allow(clippy::too_many_arguments)]
fn init_agent(a: &mut Agent, agent: Pubkey, owner: Pubkey, kind: u8, mint: Pubkey, hosted: bool, operator: [u8; 32], capabilities: [u8; 32],
    bump: u8) -> Result<()> {
    require!(agent != Pubkey::default() && owner != Pubkey::default(), RegistryError::InvalidParams);
    a.agent = agent;
    a.owner = owner;
    a.kind = kind;
    a.mint = mint;
    a.hosted = hosted;
    a.burned = 0;
    a.bond = 0;
    a.unbond_amount = 0;
    a.unbond_requested_at = 0;
    a.unbond_ready_at = 0;
    a.strikes_total = 0;
    a.strikes_epoch = 0;
    a.strikes_in_epoch = 0;
    a.suspended_through_epoch = 0;
    a.slashed_total = 0;
    a.operator = operator;
    a.capabilities = capabilities;
    a.registered_at = Clock::get()?.unix_timestamp;
    a.bump = bump;
    a.signing_key = agent;
    a.key_seq = 0;
    a.key_changed_at = 0;
    a.profile_digest = [0; 32];
    a.profile_seq = 0;
    a.pending_owner = Pubkey::default();
    a.owner_since = a.registered_at;
    a.v2_reserved = [0; 32];
    Ok(())
}

fn vault_transfer<'info>(token_program: &Interface<'info, TokenInterface>, from: &InterfaceAccount<'info, TokenAccount>,
    mint: &InterfaceAccount<'info, Mint>, to: &InterfaceAccount<'info, TokenAccount>, authority: &UncheckedAccount<'info>, seeds: &[&[u8]],
    amount: u64) -> Result<()> {
    token_interface::transfer_checked(
        CpiContext::new_with_signer(token_program.to_account_info(), TransferChecked {
            from: from.to_account_info(),
            mint: mint.to_account_info(),
            to: to.to_account_info(),
            authority: authority.to_account_info(),
        }, &[seeds]),
        amount,
        mint.decimals,
    )
}

/// Grows a program-owned account to `new_len`, the payer topping up its rent first.
pub fn grow<'info>(info: &AccountInfo<'info>, payer: &AccountInfo<'info>, system_program: &AccountInfo<'info>, new_len: usize) -> Result<()> {
    let need = Rent::get()?.minimum_balance(new_len).saturating_sub(info.lamports());
    if need > 0 {
        anchor_lang::system_program::transfer(
            CpiContext::new(system_program.clone(), anchor_lang::system_program::Transfer { from: payer.clone(), to: info.clone() }), need)?;
    }
    info.realloc(new_len, true)?;
    Ok(())
}

/// `$LINE` may be a classic SPL mint or a Token-2022 mint carrying only a metadata pointer and
/// metadata (as Pump.fun's create_v2 mints). Every other extension is refused: a transfer fee or
/// hook would break exact vault accounting, a permanent delegate could take any vault, and
/// confidential, non-transferable or default-frozen mints cannot move through the vaults.
pub fn check_mint_extensions(mint: &AccountInfo) -> Result<()> {
    use anchor_spl::token_2022::spl_token_2022::extension::{BaseStateWithExtensions, ExtensionType, StateWithExtensions};
    use anchor_spl::token_2022::spl_token_2022::state::Mint as T22Mint;
    if *mint.owner != anchor_spl::token_2022::ID {
        return Ok(());
    }
    let data = mint.try_borrow_data()?;
    let state = StateWithExtensions::<T22Mint>::unpack(&data).map_err(|_| error!(RegistryError::MintExtension))?;
    let types = state.get_extension_types().map_err(|_| error!(RegistryError::MintExtension))?;
    require!(types.iter().all(|t| matches!(t, ExtensionType::MetadataPointer | ExtensionType::TokenMetadata)), RegistryError::MintExtension);
    Ok(())
}

// ---------- state ----------

/// Every economic parameter of SPEC 13 that the chain holds (Core reads the rest from it too).
/// Fractions are basis points; Core's `finder_share` 0.1 is `finder_share_bps` 1,000.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct Params {
    pub register_burn: u64,
    pub min_bond: u64,
    pub bond_cap: u64,
    pub unbond_cooldown_s: i64,
    pub epoch_length_s: u32,
    pub reserve_bps: u16,
    pub pool_bps: u16,
    pub canary_slash_bps: u16,
    pub minority_slash_bps: u16,
    pub reveal_slash_bps: u16,
    pub strike_limit: u16,
    pub u_replay: u32,
    pub u_author: u32,
    pub finder_share_bps: u16,
    pub value_cap: u32,
    pub rebate_per_class: u64,
    pub max_open_candidates_per_agent: u16,
    /// 0 = author rewards to the agent's compute vault, 1 = to the launcher.
    pub author_reward_to: u8,
    pub quorum: u8,
}
impl Params {
    pub fn validate(&self) -> Result<()> {
        require!(self.reserve_bps as u64 + self.pool_bps as u64 == BPS, RegistryError::InvalidParams);
        require!([self.canary_slash_bps, self.minority_slash_bps, self.reveal_slash_bps, self.finder_share_bps].iter().all(|b| *b as u64 <= BPS),
            RegistryError::InvalidParams);
        require!(self.author_reward_to <= 1 && self.unbond_cooldown_s >= 0, RegistryError::InvalidParams);
        // A bond must stay slashable for at least two epochs after an unbond request, so a slash
        // Core decides in the epoch of the request (or the next) lands before the bond leaves.
        require!(self.epoch_length_s > 0 && self.unbond_cooldown_s >= 2 * self.epoch_length_s as i64, RegistryError::InvalidParams);
        // `bond_cap` caps an agent's assignment weight (SPEC 10.1, `min(bond, bond_cap)`); it is
        // not a cap on the bond itself, but it may not sit below the eligibility floor.
        require!(self.min_bond <= self.bond_cap, RegistryError::InvalidParams);
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct ConfigArgs {
    pub admin: Pubkey,
    pub core_authority: Pubkey,
    pub launch_program: Pubkey,
    pub params: Params,
    /// Most `rebate_amount` one `post_epoch` may move from the reserve.
    pub max_rebate_per_epoch: u64,
}
impl ConfigArgs {
    pub fn validate(&self) -> Result<()> {
        self.params.validate()?;
        require!(self.admin != Pubkey::default() && self.core_authority != Pubkey::default() && self.launch_program != Pubkey::default(),
            RegistryError::InvalidParams);
        Ok(())
    }
}

/// Bytes `Config` gained after the first devnet layout (`migrate_config`).
pub const CONFIG_V1_TAIL: usize = 8 + 8 + 8;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub core_authority: Pubkey,
    pub launch_program: Pubkey,
    pub mint: Pubkey,
    pub token_program: Pubkey,
    pub params: Params,
    pub paused: bool,
    pub epochs_posted: u64,
    pub last_epoch: u64,
    pub bump: u8,
    pub vault_authority_bump: u8,
    pub max_rebate_per_epoch: u64,
    /// `post_epoch` clock bound: epoch `epoch_anchor` was posted at `epoch_anchor_ts`; epoch
    /// `anchor + k` (k >= 2) may not be posted before `anchor_ts + (k - 1) x epoch_length_s`.
    pub epoch_anchor: u64,
    pub epoch_anchor_ts: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Agent {
    /// The agent's ed25519 key (its Core id in base58).
    pub agent: Pubkey,
    /// Wallet that registered it (verifier) or launched it (launched agent); receives
    /// `agent:<id>:wallet` payouts and withdrawn bonds.
    pub owner: Pubkey,
    pub kind: u8,
    /// Agent token mint (launched agents), default otherwise.
    pub mint: Pubkey,
    pub hosted: bool,
    pub burned: u64,
    pub bond: u64,
    pub unbond_amount: u64,
    pub unbond_requested_at: i64,
    pub unbond_ready_at: i64,
    pub strikes_total: u32,
    pub strikes_epoch: u64,
    pub strikes_in_epoch: u16,
    pub suspended_through_epoch: u64,
    pub slashed_total: u64,
    /// sha256 of the declared operator group (Core's `operator`), zero if none.
    pub operator: [u8; 32],
    /// sha256 of the canonical capabilities JSON (SPEC 6.1), zero if none.
    pub capabilities: [u8; 32],
    pub registered_at: i64,
    pub bump: u8,
    // ---- Agent v2 (identity plan I1), appended; `migrate_agent` grows v1 records ----
    /// The key that currently speaks for the agent (equal to `agent` until the first rotation);
    /// `Pubkey::default()` means revoked.
    pub signing_key: Pubkey,
    /// Rotations and revocations so far.
    pub key_seq: u32,
    /// Unix seconds of the last rotation or revocation (0 if none).
    pub key_changed_at: i64,
    /// sha256 of the canonical profile document (identity plan 2.3), zero if none.
    pub profile_digest: [u8; 32],
    pub profile_seq: u32,
    /// Proposed owner of a two-step transfer, default if none.
    pub pending_owner: Pubkey,
    /// Unix seconds since the current owner controls the agent (registration, or the last
    /// `accept_owner`): the credential's `controller_since`.
    pub owner_since: i64,
    /// Room for an attestation pointer (SAS or ERC-8004 id) without another migration.
    pub v2_reserved: [u8; 32],
}

/// Bytes `Agent` gained in v2 (`migrate_agent`): 32 + 4 + 8 + 32 + 4 + 32 + 8 + 32.
pub const AGENT_V1_TAIL: usize = 32 + 4 + 8 + 32 + 4 + 32 + 8 + 32;
/// Bytes `Epoch` gained with `record_root` (`migrate_epoch`).
pub const EPOCH_V1_TAIL: usize = 32;

#[account]
#[derive(InitSpace)]
pub struct Epoch {
    pub epoch: u64,
    pub payout_root: [u8; 32],
    pub lineage_root: [u8; 32],
    /// Core's total units x 1,000,000 (units are fractional).
    pub total_units_micro: u64,
    pub pool_amount: u64,
    pub rebate_amount: u64,
    pub total_payable: u64,
    pub claimed_amount: u64,
    pub claims: u32,
    pub posted_at: i64,
    pub bump: u8,
    /// Merkle root of the epoch's reputation and contribution records (identity plan 2.4), zero on
    /// epochs posted before it existed. No leaf is verified onchain; readers verify offchain.
    pub record_root: [u8; 32],
}

/// One per slash Core sent (PDA `slash`, slash id); its existence refuses a second landing.
#[account]
#[derive(InitSpace)]
pub struct SlashReceipt {
    pub slash_id: [u8; 32],
    pub agent: Pubkey,
    pub offence: u8,
    pub epoch: u64,
    pub amount: u64,
    pub slashed_at: i64,
}

/// One per paid leaf; its existence refuses a second claim.
#[account]
#[derive(InitSpace)]
pub struct ClaimReceipt {
    pub epoch: u64,
    pub leaf: [u8; 32],
    pub agent: Pubkey,
    pub dest_token: Pubkey,
    pub amount: u64,
    pub claimed_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct RegisterLaunchedArgs {
    pub agent: Pubkey,
    pub owner: Pubkey,
    pub mint: Pubkey,
    pub hosted: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct PostEpochArgs {
    pub epoch: u64,
    pub payout_root: [u8; 32],
    pub lineage_root: [u8; 32],
    pub total_units_micro: u64,
    pub pool_amount: u64,
    pub rebate_amount: u64,
    pub record_root: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct ClaimArgs {
    pub agent: Pubkey,
    /// 0 `agent:<id>:wallet`, 1 `agent:<id>:compute`, 2 `wallet:<wallet>`.
    pub dest_kind: u8,
    /// The address in `wallet:<address>` (dest_kind 2), default otherwise.
    pub wallet: Pubkey,
    pub amount: u64,
    /// The leaf hash (also the receipt seed); must equal the recomputed leaf.
    pub leaf: [u8; 32],
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
        constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()) @ RegistryError::Unauthorized)]
    pub program_data: Box<Account<'info, ProgramData>>,
    #[account(mint::token_program = token_program)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: PDA signer of every vault.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(init, payer = upgrade_authority, seeds = [BOND_VAULT_SEED], bump, token::mint = mint, token::authority = vault_authority,
        token::token_program = token_program)]
    pub bond_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = upgrade_authority, seeds = [TREASURY_SEED], bump, token::mint = mint, token::authority = vault_authority,
        token::token_program = token_program)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = upgrade_authority, seeds = [RESERVE_SEED], bump, token::mint = mint, token::authority = vault_authority,
        token::token_program = token_program)]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = upgrade_authority, seeds = [POOL_SEED], bump, token::mint = mint, token::authority = vault_authority,
        token::token_program = token_program)]
    pub pool_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(init, payer = upgrade_authority, seeds = [PAYABLE_SEED], bump, token::mint = mint, token::authority = vault_authority,
        token::token_program = token_program)]
    pub payable_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = admin @ RegistryError::Unauthorized)]
    pub config: Box<Account<'info, Config>>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct MigrateConfig<'info> {
    /// CHECK: the old layout cannot deserialize; discriminator, length and admin are checked by hand.
    #[account(mut, seeds = [CONFIG_SEED], bump)]
    pub config: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Register<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = mint, has_one = token_program)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub owner: Signer<'info>,
    pub agent: Signer<'info>,
    #[account(init, payer = owner, space = 8 + Agent::INIT_SPACE, seeds = [AGENT_SEED, agent.key().as_ref()], bump)]
    pub agent_record: Box<Account<'info, Agent>>,
    #[account(mut)]
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = owner, token::token_program = token_program)]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: RegisterLaunchedArgs)]
pub struct RegisterLaunched<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    /// `lineage_launch`'s authority PDA (checked in the handler against `config.launch_program`).
    pub launch_authority: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Agent::INIT_SPACE, seeds = [AGENT_SEED, args.agent.as_ref()], bump)]
    pub agent_record: Box<Account<'info, Agent>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OwnerAgent<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub owner: Signer<'info>,
    #[account(mut, seeds = [AGENT_SEED, agent_record.agent.as_ref()], bump = agent_record.bump, has_one = owner @ RegistryError::Unauthorized)]
    pub agent_record: Box<Account<'info, Agent>>,
}

#[derive(Accounts)]
pub struct RotateAgentKey<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub owner: Signer<'info>,
    pub new_key: Signer<'info>,
    #[account(mut, seeds = [AGENT_SEED, agent_record.agent.as_ref()], bump = agent_record.bump, has_one = owner @ RegistryError::Unauthorized)]
    pub agent_record: Box<Account<'info, Agent>>,
}

#[derive(Accounts)]
pub struct SetProfile<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub signing_key: Signer<'info>,
    #[account(mut, seeds = [AGENT_SEED, agent_record.agent.as_ref()], bump = agent_record.bump)]
    pub agent_record: Box<Account<'info, Agent>>,
}

#[derive(Accounts)]
pub struct AcceptOwner<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    pub new_owner: Signer<'info>,
    #[account(mut, seeds = [AGENT_SEED, agent_record.agent.as_ref()], bump = agent_record.bump)]
    pub agent_record: Box<Account<'info, Agent>>,
}

#[derive(Accounts)]
pub struct MigrateAgent<'info> {
    /// CHECK: the v1 layout cannot deserialize; owner (this program), discriminator, length and
    /// PDA address are checked by hand.
    #[account(mut, owner = crate::ID)]
    pub agent_record: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MigrateEpoch<'info> {
    /// CHECK: as in `MigrateAgent`.
    #[account(mut, owner = crate::ID)]
    pub epoch: UncheckedAccount<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BondCtx<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = mint, has_one = token_program)]
    pub config: Box<Account<'info, Config>>,
    pub owner: Signer<'info>,
    #[account(mut, seeds = [AGENT_SEED, agent_record.agent.as_ref()], bump = agent_record.bump, has_one = owner @ RegistryError::Unauthorized)]
    pub agent_record: Box<Account<'info, Agent>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = owner, token::token_program = token_program)]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [BOND_VAULT_SEED], bump)]
    pub bond_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct WithdrawUnbonded<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = mint, has_one = token_program)]
    pub config: Box<Account<'info, Config>>,
    pub owner: Signer<'info>,
    #[account(mut, seeds = [AGENT_SEED, agent_record.agent.as_ref()], bump = agent_record.bump, has_one = owner @ RegistryError::Unauthorized)]
    pub agent_record: Box<Account<'info, Agent>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, token::mint = mint, token::authority = owner, token::token_program = token_program)]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: PDA signer.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [BOND_VAULT_SEED], bump)]
    pub bond_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(offence: u8, epoch: u64, slash_id: [u8; 32])]
pub struct Slash<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = core_authority @ RegistryError::Unauthorized, has_one = mint,
        has_one = token_program)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub core_authority: Signer<'info>,
    #[account(init, payer = core_authority, space = 8 + SlashReceipt::INIT_SPACE, seeds = [SLASH_SEED, &slash_id], bump)]
    pub slash_receipt: Box<Account<'info, SlashReceipt>>,
    #[account(mut, seeds = [AGENT_SEED, agent_record.agent.as_ref()], bump = agent_record.bump)]
    pub agent_record: Box<Account<'info, Agent>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: PDA signer.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [BOND_VAULT_SEED], bump)]
    pub bond_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [RESERVE_SEED], bump)]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Split<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = mint, has_one = token_program)]
    pub config: Box<Account<'info, Config>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: PDA signer.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [TREASURY_SEED], bump)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [RESERVE_SEED], bump)]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [POOL_SEED], bump)]
    pub pool_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
#[instruction(args: PostEpochArgs)]
pub struct PostEpoch<'info> {
    #[account(mut, seeds = [CONFIG_SEED], bump = config.bump, has_one = core_authority @ RegistryError::Unauthorized, has_one = mint,
        has_one = token_program)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub core_authority: Signer<'info>,
    #[account(init, payer = core_authority, space = 8 + Epoch::INIT_SPACE, seeds = [EPOCH_SEED, &args.epoch.to_le_bytes()], bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: PDA signer.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [POOL_SEED], bump)]
    pub pool_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [RESERVE_SEED], bump)]
    pub reserve_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [PAYABLE_SEED], bump)]
    pub payable_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(args: ClaimArgs)]
pub struct Claim<'info> {
    #[account(seeds = [CONFIG_SEED], bump = config.bump, has_one = mint, has_one = token_program)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(mut, seeds = [EPOCH_SEED, &epoch.epoch.to_le_bytes()], bump = epoch.bump)]
    pub epoch: Box<Account<'info, Epoch>>,
    #[account(init, payer = payer, space = 8 + ClaimReceipt::INIT_SPACE, seeds = [CLAIM_SEED, &epoch.epoch.to_le_bytes(), &args.leaf], bump)]
    pub receipt: Box<Account<'info, ClaimReceipt>>,
    /// Needed for `agent:<id>:wallet` leaves (the owner's wallet is read from it). Typed, so it is
    /// owned by this program and only ever created at its PDA.
    pub agent_record: Option<Box<Account<'info, Agent>>>,
    pub mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: PDA signer.
    #[account(seeds = [VAULT_AUTHORITY_SEED], bump = config.vault_authority_bump)]
    pub vault_authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [PAYABLE_SEED], bump)]
    pub payable_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = mint, token::token_program = token_program)]
    pub dest_token: Box<InterfaceAccount<'info, TokenAccount>>,
    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
    /// CHECK: the `ChallengeConfig` PDA, read only if it exists (claims are held for its window).
    #[account(seeds = [CHALLENGE_CONFIG_SEED], bump)]
    pub challenge_config: UncheckedAccount<'info>,
    /// CHECK: this epoch's `ChallengeGate` PDA, read only if it exists (claims wait while it is open).
    #[account(seeds = [GATE_SEED, &epoch.epoch.to_le_bytes()], bump)]
    pub challenge_gate: UncheckedAccount<'info>,
}

// ---------- events and errors ----------

#[event]
pub struct ConfigSet {
    pub admin: Pubkey,
    pub core_authority: Pubkey,
    pub launch_program: Pubkey,
    pub params: Params,
}
#[event]
pub struct EpochCursorSet {
    pub epochs_posted: u64,
    pub last_epoch: u64,
    pub anchor: u64,
    pub anchor_ts: i64,
}
#[event]
pub struct Paused {
    pub paused: bool,
}
#[event]
pub struct Registered {
    pub agent: Pubkey,
    pub owner: Pubkey,
    pub kind: u8,
    pub mint: Pubkey,
    pub burned: u64,
    pub hosted: bool,
}
#[event]
pub struct Bonded {
    pub agent: Pubkey,
    pub amount: u64,
    pub bond: u64,
}
#[event]
pub struct UnbondRequested {
    pub agent: Pubkey,
    pub amount: u64,
    pub ready_at: i64,
}
#[event]
pub struct Unbonded {
    pub agent: Pubkey,
    pub amount: u64,
    pub bond: u64,
}
#[event]
pub struct Slashed {
    pub agent: Pubkey,
    pub offence: u8,
    pub epoch: u64,
    pub amount: u64,
    pub bond: u64,
    pub strikes_in_epoch: u16,
    pub suspended_through_epoch: u64,
}
#[event]
pub struct SplitDone {
    pub total: u64,
    pub reserve: u64,
    pub pool: u64,
}
#[event]
pub struct EpochPosted {
    pub epoch: u64,
    pub payout_root: [u8; 32],
    pub lineage_root: [u8; 32],
    pub record_root: [u8; 32],
    pub pool_amount: u64,
    pub rebate_amount: u64,
    pub total_units_micro: u64,
}
#[event]
pub struct KeyRotated {
    pub agent: Pubkey,
    pub old: Pubkey,
    pub new: Pubkey,
    pub seq: u32,
}
#[event]
pub struct KeyRevoked {
    pub agent: Pubkey,
    pub old: Pubkey,
    pub seq: u32,
}
#[event]
pub struct ProfileSet {
    pub agent: Pubkey,
    pub digest: [u8; 32],
    pub seq: u32,
}
#[event]
pub struct OwnerProposed {
    pub agent: Pubkey,
    pub owner: Pubkey,
    pub proposed: Pubkey,
}
#[event]
pub struct OwnerChanged {
    pub agent: Pubkey,
    pub old: Pubkey,
    pub new: Pubkey,
    pub at: i64,
}
#[event]
pub struct AgentMigrated {
    pub agent: Pubkey,
}
#[event]
pub struct Claimed {
    pub epoch: u64,
    pub agent: Pubkey,
    pub dest_kind: u8,
    pub dest_token: Pubkey,
    pub amount: u64,
    pub leaf: [u8; 32],
}

#[error_code]
pub enum RegistryError {
    #[msg("signer is not authorized")]
    Unauthorized,
    #[msg("the registry is paused")]
    Paused,
    #[msg("invalid parameters")]
    InvalidParams,
    #[msg("amount must be positive")]
    ZeroAmount,
    #[msg("invalid amount")]
    InvalidAmount,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("hosted agents cannot bond")]
    Hosted,
    #[msg("no unbond request")]
    NoUnbond,
    #[msg("unbond cooldown has not passed")]
    Cooldown,
    #[msg("register_launched must be signed by lineage_launch's authority")]
    NotLaunchProgram,
    #[msg("epochs must be posted in increasing order")]
    EpochOrder,
    #[msg("destination does not match the leaf")]
    BadDestination,
    #[msg("leaf does not match its fields")]
    LeafMismatch,
    #[msg("invalid Merkle proof")]
    BadProof,
    #[msg("claims would exceed the epoch total")]
    OverClaim,
    #[msg("epoch posted ahead of the clock")]
    EpochTooEarly,
    #[msg("rebate above max_rebate_per_epoch")]
    RebateCap,
    #[msg("$LINE mint has an unsupported Token-2022 extension")]
    MintExtension,
    #[msg("the agent's signing key is revoked")]
    KeyRevoked,
    #[msg("profile seq must increase")]
    ProfileSeq,
    #[msg("no owner transfer is pending")]
    NoPendingOwner,
    #[msg("payouts of this epoch are held: challenge window or an open challenge")]
    ClaimHeld,
    #[msg("challenge outside its window")]
    ChallengeWindow,
    #[msg("unknown challenge kind")]
    ChallengeKind,
    #[msg("challenge epoch is not posted or not the next epoch")]
    ChallengeEpoch,
    #[msg("challenge subject does not match its accounts")]
    ChallengeSubject,
    #[msg("challenge is not open")]
    ChallengeNotOpen,
    #[msg("invalid challenge outcome")]
    ChallengeOutcome,
    #[msg("challenge resolve timeout has not passed")]
    ChallengeTimeout,
}
