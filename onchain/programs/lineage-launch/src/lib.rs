//! `lineage_launch` (SPEC 14.2): agent tokens on pump.fun quoted in `$LINE` (owner decisions
//! 2026-10-10, docs/plans/PUMPFUN-LAUNCHES.md). The launcher's transaction calls pump.fun's
//! `create_v2` at the top level with `creator` = this program's PDA ["pump_creator", agent];
//! `register_pump_launch` then checks the new bonding curve and the same transaction's `create_v2`
//! and records the launch. This program never calls pump.fun. pump.fun's permissionless sweeps and
//! collects pay the creator fees in `$LINE` to the creator PDA's ATA, and `crank_pump_fees` splits
//! that balance between the agent's compute vault (`agent_compute_bps`) and the registry treasury
//! (`protocol_bps`). Records written by the earlier Meteora venue keep their bytes (devnet history).
use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface, TransferChecked};
use lineage_registry::leaf;

pub mod bounty;
pub mod pump;
pub use bounty::*;
use pump as pf;

// Network ids by build feature, as in lineage_registry: devnet by default, `mainnet` for mainnet.
#[cfg(not(feature = "mainnet"))]
declare_id!("8eHzm1XtNtbxJujrMAci4VdhCJvQttFUBukmkFaUwsAT");
#[cfg(feature = "mainnet")]
declare_id!("2vwKsTZm5doa3ahBmpm8Sv3sKPD76Fq2ZZENbNW5BYBq");

pub const LAUNCH_CONFIG_SEED: &[u8] = b"launch_config";
pub const AUTHORITY_SEED: &[u8] = lineage_registry::LAUNCH_AUTHORITY_SEED;
pub const AGENT_LAUNCH_SEED: &[u8] = b"agent_launch";
pub const COMPUTE_SEED: &[u8] = lineage_registry::COMPUTE_SEED;
pub const USAGE_SEED: &[u8] = b"usage";
pub const DEBIT_SEED: &[u8] = b"debit";
pub const BPS: u64 = 10_000;
/// Longest repository URL `register_pump_launch` accepts.
pub const MAX_URL: usize = 200;
/// PDA ["pump_creator", agent]: the pump.fun `creator` of the agent's coin, so fees accrue per agent.
pub const PUMP_CREATOR_SEED: &[u8] = b"pump_creator";
/// `AgentLaunch.venue` of a pump.fun launch (a Meteora-era record holds its DBC config there).
pub const VENUE_PUMP: Pubkey = pf::PUMP_PROGRAM_ID;
/// A pump.fun coin quoted in a pump coin has curve depth 1 (`max_curve_depth` 1 on mainnet 2026-10-10).
pub const PUMP_QUOTED_DEPTH: u8 = 1;
pub const MAX_PROOF: usize = 32;
pub const IDENTITY_TOKEN: u8 = 0;
pub const IDENTITY_PURCHASED: u8 = 1;
pub const IDENTITY_APP: u8 = 2;

#[program]
pub mod lineage_launch {
    use super::*;

    /// Once, by the upgrade authority (through ProgramData).
    pub fn initialize_launch(ctx: Context<InitializeLaunch>, args: LaunchConfigArgs) -> Result<()> {
        args.validate()?;
        lineage_registry::check_mint_extensions(&ctx.accounts.line_mint.to_account_info())?;
        let c = &mut ctx.accounts.launch_config;
        c.line_mint = ctx.accounts.line_mint.key();
        c.line_token_program = ctx.accounts.line_token_program.key();
        c.bump = ctx.bumps.launch_config;
        c.authority_bump = ctx.bumps.authority;
        c.usage_epochs_posted = 0;
        c.last_usage_epoch = 0;
        c.usage_anchor = 0;
        c.usage_anchor_ts = 0;
        apply_args(c, &args);
        emit!(LaunchConfigSet { args });
        Ok(())
    }

    /// Admin: every field, including the creator fee rate pump.fun launches must carry.
    pub fn set_launch_config(ctx: Context<SetLaunchConfig>, args: LaunchConfigArgs) -> Result<()> {
        args.validate()?;
        apply_args(&mut ctx.accounts.launch_config, &args);
        emit!(LaunchConfigSet { args });
        Ok(())
    }

    /// Admin, once per layout change: grows a `LaunchConfig` written by the first deployed layout
    /// (no debit cap, no usage sequence) to the current one; the usage sequence starts empty.
    pub fn migrate_launch_config(ctx: Context<MigrateLaunchConfig>, max_debit_per_epoch: u64) -> Result<()> {
        let info = ctx.accounts.launch_config.to_account_info();
        let new_len = 8 + LaunchConfig::INIT_SPACE;
        require!(info.data_len() == new_len - LAUNCH_CONFIG_V1_TAIL, LaunchError::InvalidArgs);
        {
            let d = info.try_borrow_data()?;
            require!(d[..8] == *LaunchConfig::DISCRIMINATOR, LaunchError::InvalidArgs);
            require!(d[8..40] == ctx.accounts.admin.key().to_bytes(), LaunchError::Unauthorized);
        }
        lineage_registry::grow(&info, &ctx.accounts.admin.to_account_info(), &ctx.accounts.system_program.to_account_info(), new_len)?;
        let mut c = LaunchConfig::try_deserialize(&mut &info.try_borrow_data()?[..])?;
        c.max_debit_per_epoch = max_debit_per_epoch;
        c.registry_program = lineage_registry::ID;
        c.try_serialize(&mut &mut info.try_borrow_mut_data()?[..])?;
        Ok(())
    }

    /// The launcher registers the agent coin its transaction just created on pump.fun: an earlier
    /// top-level instruction of the same transaction is Pump `create_v2` for `agent_mint`, and the
    /// bonding curve it wrote is quoted in `$LINE`, has this agent's creator PDA as `creator`, depth
    /// 1, no mayhem, cashback or holder rewards, the configured creator fee rate, Global's supply and
    /// no trade yet. Then the compute vault, the `AgentLaunch` record and the registry's `Agent`
    /// (`register_launched`). The agent key co-signs: one agent per key, and nobody can launch a
    /// token for a key they do not hold.
    pub fn register_pump_launch(ctx: Context<RegisterPumpLaunch>, args: PumpLaunchArgs) -> Result<()> {
        let c = &ctx.accounts.launch_config;
        require!(!c.paused, LaunchError::Paused);
        require!(args.identity_mode <= IDENTITY_APP, LaunchError::InvalidArgs);
        check_canonical_url(args.repo_url.as_bytes())?;
        let mint = ctx.accounts.agent_mint.key();
        let curve_info = ctx.accounts.bonding_curve.to_account_info();
        let curve = pf::read_curve(&curve_info, &mint)?;
        require!(pf::created_in_this_tx(&ctx.accounts.instructions.to_account_info(), &mint, &curve_info.key())?, LaunchError::NotCreatedInThisTx);
        require_keys_eq!(curve.quote_mint, c.line_mint, LaunchError::PumpWrongQuote);
        require_keys_eq!(curve.creator, ctx.accounts.pump_creator.key(), LaunchError::PumpWrongCreator);
        require!(curve.depth == PUMP_QUOTED_DEPTH && !curve.is_mayhem_mode && !curve.is_cashback_coin && !curve.is_holder_reward,
            LaunchError::PumpCurveInvalid);
        require!(curve.creator_fee_bps == c.pump_creator_fee_bps, LaunchError::PumpCreatorFee);
        let (initial_real, total_supply) = pf::read_global_supply(&ctx.accounts.pump_global)?;
        require!(!curve.complete && curve.real_quote_reserves == 0 && curve.real_token_reserves == initial_real && curve.token_total_supply == total_supply,
            LaunchError::PumpCurveInvalid);

        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[c.authority_bump]];
        lineage_registry::cpi::register_launched(
            CpiContext::new_with_signer(ctx.accounts.registry_program.to_account_info(), lineage_registry::cpi::accounts::RegisterLaunched {
                config: ctx.accounts.registry_config.to_account_info(),
                launch_authority: ctx.accounts.authority.to_account_info(),
                payer: ctx.accounts.launcher.to_account_info(),
                agent_record: ctx.accounts.agent_record.to_account_info(),
                system_program: ctx.accounts.system_program.to_account_info(),
            }, &[seeds]),
            lineage_registry::RegisterLaunchedArgs {
                agent: ctx.accounts.agent.key(),
                owner: ctx.accounts.launcher.key(),
                mint,
                hosted: args.hosted,
            },
        )?;

        let l = &mut ctx.accounts.agent_launch;
        l.agent = ctx.accounts.agent.key();
        l.mint = mint;
        l.launcher = ctx.accounts.launcher.key();
        l.repo_id = leaf::repo_id(args.repo_url.as_bytes());
        l.repo_url = args.repo_url;
        l.identity_mode = args.identity_mode;
        l.hosted = args.hosted;
        l.venue = VENUE_PUMP;
        l.bonding_curve = curve_info.key();
        l.pump_pool = Pubkey::default();
        l.pump_creator = ctx.accounts.pump_creator.key();
        l.reserved = Pubkey::default();
        l.graduated = false;
        l.awake = false;
        l.created_at = Clock::get()?.unix_timestamp;
        l.fees_claimed = 0;
        l.to_compute = 0;
        l.to_protocol = 0;
        l.debited = 0;
        l.withdrawn = 0;
        l.bump = ctx.bumps.agent_launch;
        l.compute_bump = ctx.bumps.compute_vault;
        emit!(PumpLaunched { agent: l.agent, mint: l.mint, launcher: l.launcher, bonding_curve: l.bonding_curve, pump_creator: l.pump_creator,
            repo_id: l.repo_id, identity_mode: l.identity_mode, hosted: l.hosted });
        Ok(())
    }

    /// Anyone: splits the `$LINE` that pump.fun's sweeps and collects paid into the agent's creator
    /// PDA ATA (the keeper puts Pump `sweep_creator_fee` + `collect_creator_fee_v2`, and after
    /// migration PumpSwap `sweep_creator_fee` + `collect_coin_creator_fee`, before it in the same
    /// transaction). compute = floor(balance x agent_compute_bps / 10,000) to the compute vault,
    /// protocol = the rest to the registry treasury, both signed by the creator PDA. `$LINE` anyone
    /// sends to that ATA is treated as fees.
    pub fn crank_pump_fees(ctx: Context<CrankPumpFees>) -> Result<()> {
        let c = &ctx.accounts.launch_config;
        require!(!c.paused, LaunchError::Paused);
        let fees = ctx.accounts.creator_line_token.amount;
        require!(fees > 0, LaunchError::NothingToClaim);
        let to_compute = (fees as u128 * c.agent_compute_bps as u128 / BPS as u128) as u64;
        let to_protocol = fees - to_compute;
        let agent = ctx.accounts.agent_launch.agent;
        let bump = [ctx.bumps.pump_creator];
        let seeds: &[&[u8]] = &[PUMP_CREATOR_SEED, agent.as_ref(), &bump];
        for (to, amount) in [(ctx.accounts.compute_vault.to_account_info(), to_compute), (ctx.accounts.treasury.to_account_info(), to_protocol)] {
            if amount > 0 {
                token_interface::transfer_checked(
                    CpiContext::new_with_signer(ctx.accounts.line_token_program.to_account_info(), TransferChecked {
                        from: ctx.accounts.creator_line_token.to_account_info(),
                        mint: ctx.accounts.line_mint.to_account_info(),
                        to,
                        authority: ctx.accounts.pump_creator.to_account_info(),
                    }, &[seeds]),
                    amount,
                    ctx.accounts.line_mint.decimals,
                )?;
            }
        }
        ctx.accounts.compute_vault.reload()?;
        let balance = ctx.accounts.compute_vault.amount;
        let l = &mut ctx.accounts.agent_launch;
        l.fees_claimed = l.fees_claimed.saturating_add(fees);
        l.to_compute = l.to_compute.saturating_add(to_compute);
        l.to_protocol = l.to_protocol.saturating_add(to_protocol);
        update_awake(l, balance, c);
        emit!(FeesCranked { agent: l.agent, mint: l.mint, fees, to_compute, to_protocol, pool_fees: l.graduated, balance, awake: l.awake });
        Ok(())
    }

    /// Anyone, once: records graduation after pump.fun's migration. The curve is complete and the
    /// pool is the canonical PumpSwap pool of the agent's mint quoted in `$LINE` (address, owner,
    /// discriminator, index 0, creator = Pump's pool authority for the mint). Fees keep flowing
    /// through `crank_pump_fees`; the pool's `coin_creator` is reported, not required, so a
    /// pump.fun reassignment shows in the event instead of blocking the record.
    pub fn record_pump_graduation(ctx: Context<RecordPumpGraduation>) -> Result<()> {
        let l = &ctx.accounts.agent_launch;
        require!(l.venue == VENUE_PUMP && !l.graduated, LaunchError::WrongPhase);
        let curve = pf::read_curve(&ctx.accounts.bonding_curve, &l.mint)?;
        require!(curve.complete, LaunchError::NotMigrated);
        let line_mint = ctx.accounts.launch_config.line_mint;
        let (address, pool_authority) = pf::canonical_pool(&l.mint, &line_mint);
        require_keys_eq!(ctx.accounts.pool.key(), address, LaunchError::PumpPoolUnexpected);
        let pool = pf::read_pool(&ctx.accounts.pool)?;
        require!(pool.index == 0 && pool.creator == pool_authority && pool.base_mint == l.mint && pool.quote_mint == line_mint,
            LaunchError::PumpPoolUnexpected);
        let l = &mut ctx.accounts.agent_launch;
        l.graduated = true;
        l.pump_pool = address;
        emit!(PumpGraduated { agent: l.agent, mint: l.mint, pool: address, coin_creator: pool.coin_creator,
            creator_is_ours: pool.coin_creator == l.pump_creator });
        Ok(())
    }

    /// Hosted runtime authority, once per epoch: the Merkle root of that epoch's usage records
    /// (leaf = `leafHash(canonicalJson({ agent, amount, epoch, model_tokens, sandbox_s }))`).
    /// One sequence, as the registry's epochs: the first post sets the anchor, every later one is
    /// exactly the next epoch and at most one epoch (the registry's `epoch_length_s`) ahead of
    /// the wall clock measured from the anchor, so a runtime key cannot post epochs ahead to
    /// debit the same vaults again and again.
    pub fn post_usage(ctx: Context<PostUsage>, epoch: u64, root: [u8; 32]) -> Result<()> {
        require!(!ctx.accounts.launch_config.paused, LaunchError::Paused);
        let now = Clock::get()?.unix_timestamp;
        let c = &mut ctx.accounts.launch_config;
        if c.usage_epochs_posted > 0 {
            require!(Some(epoch) == c.last_usage_epoch.checked_add(1), LaunchError::UsageOrder);
            let ahead = epoch.checked_sub(c.usage_anchor).ok_or(LaunchError::UsageOrder)?.saturating_sub(1);
            let earliest = (ahead as i128) * (ctx.accounts.registry_config.params.epoch_length_s as i128) + c.usage_anchor_ts as i128;
            require!(now as i128 >= earliest, LaunchError::UsageOrder);
        } else {
            c.usage_anchor = epoch;
            c.usage_anchor_ts = now;
        }
        c.usage_epochs_posted += 1;
        c.last_usage_epoch = epoch;
        let u = &mut ctx.accounts.usage;
        u.epoch = epoch;
        u.root = root;
        u.posted_at = now;
        u.debited = 0;
        u.bump = ctx.bumps.usage;
        emit!(UsagePosted { epoch, root });
        Ok(())
    }

    /// Hosted runtime authority: debits one agent's posted usage for one epoch (once) from its
    /// compute vault to `compute_sink`.
    pub fn debit_compute(ctx: Context<DebitCompute>, args: DebitArgs) -> Result<()> {
        let c = &ctx.accounts.launch_config;
        require!(!c.paused, LaunchError::Paused);
        require!(args.amount > 0 && args.proof.len() <= MAX_PROOF, LaunchError::InvalidArgs);
        // Self-hosted agents run on their launcher's compute; the runtime never debits them.
        require!(ctx.accounts.agent_launch.hosted, LaunchError::NotHosted);
        let debited = ctx.accounts.usage.debited.checked_add(args.amount).ok_or(LaunchError::InvalidArgs)?;
        require!(c.max_debit_per_epoch == 0 || debited <= c.max_debit_per_epoch, LaunchError::DebitCap);
        let agent = ctx.accounts.agent_launch.agent;
        let leaf_h = leaf::usage_leaf(ctx.accounts.usage.epoch, &agent.to_bytes(), args.amount, args.model_tokens, args.sandbox_s);
        require!(leaf::verify_proof(&leaf_h, &args.proof, &ctx.accounts.usage.root), LaunchError::BadProof);
        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[c.authority_bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.line_token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.compute_vault.to_account_info(),
                mint: ctx.accounts.line_mint.to_account_info(),
                to: ctx.accounts.compute_sink.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            }, &[seeds]),
            args.amount,
            ctx.accounts.line_mint.decimals,
        )?;
        ctx.accounts.compute_vault.reload()?;
        let r = &mut ctx.accounts.receipt;
        r.epoch = ctx.accounts.usage.epoch;
        r.agent = agent;
        r.amount = args.amount;
        r.model_tokens = args.model_tokens;
        r.sandbox_s = args.sandbox_s;
        ctx.accounts.usage.debited = debited;
        let l = &mut ctx.accounts.agent_launch;
        l.debited = l.debited.saturating_add(args.amount);
        update_awake(l, ctx.accounts.compute_vault.amount, c);
        emit!(ComputeDebited { agent, epoch: r.epoch, amount: args.amount, model_tokens: args.model_tokens, sandbox_s: args.sandbox_s,
            balance: ctx.accounts.compute_vault.amount, awake: l.awake });
        Ok(())
    }

    /// The current registry owner of a self-hosted agent (its launcher until an owner transfer)
    /// withdraws compute to run it themselves.
    pub fn withdraw_compute(ctx: Context<WithdrawCompute>, amount: u64) -> Result<()> {
        let c = &ctx.accounts.launch_config;
        require!(!c.paused, LaunchError::Paused);
        require!(!ctx.accounts.agent_launch.hosted, LaunchError::Hosted);
        require!(amount > 0, LaunchError::InvalidArgs);
        // The agent's current registry owner withdraws, not the launcher recorded at launch: compute
        // follows an owner transfer like the bond and the wallet payouts do (audit A1-03).
        require_keys_eq!(ctx.accounts.agent_record.owner, ctx.accounts.owner.key(), LaunchError::Unauthorized);
        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[c.authority_bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(ctx.accounts.line_token_program.to_account_info(), TransferChecked {
                from: ctx.accounts.compute_vault.to_account_info(),
                mint: ctx.accounts.line_mint.to_account_info(),
                to: ctx.accounts.owner_token.to_account_info(),
                authority: ctx.accounts.authority.to_account_info(),
            }, &[seeds]),
            amount,
            ctx.accounts.line_mint.decimals,
        )?;
        ctx.accounts.compute_vault.reload()?;
        let l = &mut ctx.accounts.agent_launch;
        l.withdrawn = l.withdrawn.saturating_add(amount);
        update_awake(l, ctx.accounts.compute_vault.amount, c);
        emit!(ComputeWithdrawn { agent: l.agent, amount, balance: ctx.accounts.compute_vault.amount });
        Ok(())
    }

    /// Anyone: re-evaluates sleep/wake from the vault balance (for deposits that arrive by
    /// transfer, such as epoch author rewards).
    pub fn refresh_awake(ctx: Context<RefreshAwake>) -> Result<()> {
        let bal = ctx.accounts.compute_vault.amount;
        update_awake(&mut ctx.accounts.agent_launch, bal, &ctx.accounts.launch_config);
        Ok(())
    }

    /// Admin (the launch admin): creates or updates the `BountyConfig` (bounty.rs).
    pub fn set_bounty_config(ctx: Context<SetBountyConfig>, args: BountyConfigArgs) -> Result<()> {
        bounty::set_bounty_config(ctx, args)
    }

    /// The payer agent's current registry owner (self-hosted; the launcher until an owner
    /// transfer, audit A1-03) or the runtime authority (hosted): escrows `amount` from the agent's
    /// compute vault, capped per window by `max_bounty_out_bps`.
    pub fn open_bounty(ctx: Context<OpenBounty>, args: OpenBountyArgs) -> Result<()> {
        bounty::open_bounty(ctx, args)
    }

    /// Anyone: pays the escrow into the compute vault of an agent credited in an accepted
    /// generation meeting the condition, proven by its contribution leaf against the registry's
    /// `Epoch.record_root`. One receipt per (payer, leaf).
    pub fn release_bounty(ctx: Context<ReleaseBounty>, args: ReleaseArgs) -> Result<()> {
        bounty::release_bounty(ctx, args)
    }

    /// Anyone, after the deadline plus `refund_grace_s`: the escrow back to the payer's compute vault.
    pub fn refund_bounty(ctx: Context<RefundBounty>) -> Result<()> {
        bounty::refund_bounty(ctx)
    }

    /// The opener's authority, only while the registry has posted no epoch since the open.
    pub fn cancel_bounty(ctx: Context<CancelBounty>) -> Result<()> {
        bounty::cancel_bounty(ctx)
    }
}

/// Hysteresis (SPEC 13.7): asleep below `sleep_threshold`, awake again from `wake_threshold`.
pub(crate) fn update_awake(l: &mut AgentLaunch, balance: u64, c: &LaunchConfig) {
    if l.awake && balance < c.sleep_threshold {
        l.awake = false;
    } else if !l.awake && balance >= c.wake_threshold {
        l.awake = true;
    }
}

/// The URL must already be what protocol `canonicalUrl` returns for an https URL: lowercase, no
/// trailing slash, no `.git`, printable ASCII. Then `repo_id` here equals Core's `repoId(url)`.
fn check_canonical_url(u: &[u8]) -> Result<()> {
    require!(u.len() > 8 && u.len() <= MAX_URL && u.starts_with(b"https://"), LaunchError::InvalidUrl);
    require!(u.iter().all(|b| (0x21..0x7f).contains(b) && !b.is_ascii_uppercase()), LaunchError::InvalidUrl);
    require!(!u.ends_with(b"/") && !u.ends_with(b".git"), LaunchError::InvalidUrl);
    Ok(())
}

fn apply_args(c: &mut LaunchConfig, a: &LaunchConfigArgs) {
    c.admin = a.admin;
    c.runtime_authority = a.runtime_authority;
    c.registry_program = lineage_registry::ID;
    c.compute_sink = a.compute_sink;
    c.max_debit_per_epoch = a.max_debit_per_epoch;
    c.agent_compute_bps = a.agent_compute_bps;
    c.protocol_bps = a.protocol_bps;
    c.sleep_threshold = a.sleep_threshold;
    c.wake_threshold = a.wake_threshold;
    c.paused = a.paused;
    c.venue = VENUE_PUMP;
    c.pump_creator_fee_bps = a.pump_creator_fee_bps;
    c.reserved = 0;
}

// ---------- state ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct LaunchConfigArgs {
    pub admin: Pubkey,
    /// Hosted runtime: posts usage roots and debits compute vaults.
    pub runtime_authority: Pubkey,
    /// `$LINE` token account that receives debited compute.
    pub compute_sink: Pubkey,
    pub agent_compute_bps: u16,
    pub protocol_bps: u16,
    pub sleep_threshold: u64,
    pub wake_threshold: u64,
    pub paused: bool,
    /// Most the runtime may debit across all compute vaults for one usage epoch; 0 = no cap.
    pub max_debit_per_epoch: u64,
    /// The `creator_fee_bps` every pump.fun launch must be created with: 0 = pump.fun's standard
    /// schedule (owner decision 2026-10-10), else a rate pump.fun accepts (`max_configurable_creator_fee_bps`).
    pub pump_creator_fee_bps: u64,
}
impl LaunchConfigArgs {
    fn validate(&self) -> Result<()> {
        require!(self.agent_compute_bps as u64 + self.protocol_bps as u64 == BPS, LaunchError::InvalidArgs);
        require!(self.sleep_threshold <= self.wake_threshold && self.pump_creator_fee_bps <= BPS, LaunchError::InvalidArgs);
        require!(self.admin != Pubkey::default() && self.runtime_authority != Pubkey::default() && self.compute_sink != Pubkey::default(),
            LaunchError::InvalidArgs);
        Ok(())
    }
}

/// Bytes `LaunchConfig` gained after the first devnet layout (`migrate_launch_config`).
pub const LAUNCH_CONFIG_V1_TAIL: usize = 8 * 5;

#[account]
#[derive(InitSpace)]
pub struct LaunchConfig {
    pub admin: Pubkey,
    pub runtime_authority: Pubkey,
    /// Always `lineage_registry`'s id (a constant; kept in the layout for readers).
    pub registry_program: Pubkey,
    pub line_mint: Pubkey,
    pub line_token_program: Pubkey,
    pub compute_sink: Pubkey,
    /// Always Pump's program id (the venue; a Meteora-era config held its DBC config here).
    pub venue: Pubkey,
    pub agent_compute_bps: u16,
    pub protocol_bps: u16,
    pub sleep_threshold: u64,
    pub wake_threshold: u64,
    /// `creator_fee_bps` a launch's curve must carry (LaunchConfigArgs).
    pub pump_creator_fee_bps: u64,
    /// Zero (a Meteora-era config held the DBC start price here).
    pub reserved: u128,
    pub paused: bool,
    pub bump: u8,
    pub authority_bump: u8,
    pub max_debit_per_epoch: u64,
    /// `post_usage` sequence and clock anchor (see `post_usage`).
    pub usage_epochs_posted: u64,
    pub last_usage_epoch: u64,
    pub usage_anchor: u64,
    pub usage_anchor_ts: i64,
}

#[account]
#[derive(InitSpace)]
pub struct AgentLaunch {
    pub agent: Pubkey,
    pub mint: Pubkey,
    pub launcher: Pubkey,
    /// protocol `repoId(repo_url)`.
    pub repo_id: [u8; 32],
    #[max_len(200)]
    pub repo_url: String,
    pub identity_mode: u8,
    pub hosted: bool,
    /// `VENUE_PUMP` for a pump.fun launch. Records the Meteora venue wrote (devnet history) keep
    /// the same byte layout: their DBC config, DBC pool, DAMM v2 pool, position and position NFT
    /// account sit in these five fields, and no instruction of this build acts on them.
    pub venue: Pubkey,
    pub bonding_curve: Pubkey,
    /// The canonical PumpSwap pool, once `record_pump_graduation` ran.
    pub pump_pool: Pubkey,
    /// PDA ["pump_creator", agent]: the coin's pump.fun creator.
    pub pump_creator: Pubkey,
    pub reserved: Pubkey,
    pub graduated: bool,
    pub awake: bool,
    pub created_at: i64,
    pub fees_claimed: u64,
    pub to_compute: u64,
    pub to_protocol: u64,
    pub debited: u64,
    pub withdrawn: u64,
    pub bump: u8,
    pub compute_bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct UsageEpoch {
    pub epoch: u64,
    pub root: [u8; 32],
    pub posted_at: i64,
    pub debited: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct DebitReceipt {
    pub epoch: u64,
    pub agent: Pubkey,
    pub amount: u64,
    pub model_tokens: u64,
    pub sandbox_s: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct PumpLaunchArgs {
    pub repo_url: String,
    pub identity_mode: u8,
    pub hosted: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug)]
pub struct DebitArgs {
    pub amount: u64,
    pub model_tokens: u64,
    pub sandbox_s: u64,
    pub proof: Vec<[u8; 32]>,
}

// ---------- accounts ----------

#[derive(Accounts)]
pub struct InitializeLaunch<'info> {
    #[account(init, payer = upgrade_authority, space = 8 + LaunchConfig::INIT_SPACE, seeds = [LAUNCH_CONFIG_SEED], bump)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(mut)]
    pub upgrade_authority: Signer<'info>,
    #[account(seeds = [crate::ID.as_ref()], bump, seeds::program = bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()) @ LaunchError::Unauthorized)]
    pub program_data: Box<Account<'info, ProgramData>>,
    /// CHECK: PDA signer.
    #[account(seeds = [AUTHORITY_SEED], bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mint::token_program = line_token_program)]
    pub line_mint: Box<InterfaceAccount<'info, Mint>>,
    pub line_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetLaunchConfig<'info> {
    #[account(mut, seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = admin @ LaunchError::Unauthorized)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct MigrateLaunchConfig<'info> {
    /// CHECK: the old layout cannot deserialize; discriminator, length and admin are checked by hand.
    #[account(mut, seeds = [LAUNCH_CONFIG_SEED], bump)]
    pub launch_config: UncheckedAccount<'info>,
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterPumpLaunch<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = line_mint)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    /// CHECK: PDA signer of the registry's `register_launched`.
    #[account(seeds = [AUTHORITY_SEED], bump = launch_config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub launcher: Signer<'info>,
    pub agent: Signer<'info>,
    /// CHECK: the mint the same transaction's `create_v2` created (checked through its curve and the instructions sysvar).
    pub agent_mint: UncheckedAccount<'info>,
    #[account(mint::token_program = line_token_program)]
    pub line_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: read by `pump::read_curve` (owner Pump, PDA of the mint, discriminator, length).
    pub bonding_curve: UncheckedAccount<'info>,
    /// CHECK: Pump's Global (address, owner, discriminator checked by `pump::read_global_supply`).
    pub pump_global: UncheckedAccount<'info>,
    /// CHECK: PDA ["pump_creator", agent]; the curve's creator must be this address.
    #[account(seeds = [PUMP_CREATOR_SEED, agent.key().as_ref()], bump)]
    pub pump_creator: UncheckedAccount<'info>,
    #[account(init, payer = launcher, space = 8 + AgentLaunch::INIT_SPACE, seeds = [AGENT_LAUNCH_SEED, agent_mint.key().as_ref()], bump)]
    pub agent_launch: Box<Account<'info, AgentLaunch>>,
    #[account(init, payer = launcher, seeds = [COMPUTE_SEED, agent.key().as_ref()], bump, token::mint = line_mint, token::authority = authority,
        token::token_program = line_token_program)]
    pub compute_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: the registry checks its own Config.
    pub registry_config: UncheckedAccount<'info>,
    /// CHECK: created by the registry (PDA by agent).
    #[account(mut)]
    pub agent_record: UncheckedAccount<'info>,
    /// CHECK: the registry program id (a constant).
    #[account(executable, address = lineage_registry::ID)]
    pub registry_program: UncheckedAccount<'info>,
    /// CHECK: the instructions sysvar (address).
    #[account(address = anchor_lang::solana_program::sysvar::instructions::ID)]
    pub instructions: UncheckedAccount<'info>,
    pub line_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

/// The registry's treasury token account: PDA ["treasury"] of the registry program.
fn is_registry_treasury(key: &Pubkey) -> bool {
    Pubkey::find_program_address(&[lineage_registry::TREASURY_SEED], &lineage_registry::ID).0 == *key
}

#[derive(Accounts)]
pub struct CrankPumpFees<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = line_mint)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(mut, seeds = [AGENT_LAUNCH_SEED, agent_launch.mint.as_ref()], bump = agent_launch.bump,
        constraint = agent_launch.venue == VENUE_PUMP @ LaunchError::WrongPhase, has_one = pump_creator)]
    pub agent_launch: Box<Account<'info, AgentLaunch>>,
    /// CHECK: PDA ["pump_creator", agent] (seeds and has_one), signer of the transfers out of its ATA.
    #[account(seeds = [PUMP_CREATOR_SEED, agent_launch.agent.as_ref()], bump)]
    pub pump_creator: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = line_mint, associated_token::authority = pump_creator, associated_token::token_program = line_token_program)]
    pub creator_line_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [COMPUTE_SEED, agent_launch.agent.as_ref()], bump = agent_launch.compute_bump)]
    pub compute_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, constraint = is_registry_treasury(&treasury.key()) @ LaunchError::WrongTreasury)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = line_token_program)]
    pub line_mint: Box<InterfaceAccount<'info, Mint>>,
    pub line_token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct RecordPumpGraduation<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(mut, seeds = [AGENT_LAUNCH_SEED, agent_launch.mint.as_ref()], bump = agent_launch.bump, has_one = bonding_curve)]
    pub agent_launch: Box<Account<'info, AgentLaunch>>,
    /// CHECK: has_one; read by `pump::read_curve`.
    pub bonding_curve: UncheckedAccount<'info>,
    /// CHECK: the canonical pool's address, owner, discriminator and fields are checked.
    pub pool: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct PostUsage<'info> {
    #[account(mut, seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = runtime_authority @ LaunchError::Unauthorized)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    /// The registry's Config (its `epoch_length_s` bounds the usage sequence).
    #[account(seeds = [lineage_registry::CONFIG_SEED], bump = registry_config.bump, seeds::program = lineage_registry::ID)]
    pub registry_config: Box<Account<'info, lineage_registry::Config>>,
    #[account(mut)]
    pub runtime_authority: Signer<'info>,
    #[account(init, payer = runtime_authority, space = 8 + UsageEpoch::INIT_SPACE, seeds = [USAGE_SEED, &epoch.to_le_bytes()], bump)]
    pub usage: Box<Account<'info, UsageEpoch>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DebitCompute<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = runtime_authority @ LaunchError::Unauthorized, has_one = line_mint,
        has_one = compute_sink)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(mut)]
    pub runtime_authority: Signer<'info>,
    /// CHECK: PDA signer.
    #[account(seeds = [AUTHORITY_SEED], bump = launch_config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [USAGE_SEED, &usage.epoch.to_le_bytes()], bump = usage.bump)]
    pub usage: Box<Account<'info, UsageEpoch>>,
    #[account(mut, seeds = [AGENT_LAUNCH_SEED, agent_launch.mint.as_ref()], bump = agent_launch.bump)]
    pub agent_launch: Box<Account<'info, AgentLaunch>>,
    #[account(init, payer = runtime_authority, space = 8 + DebitReceipt::INIT_SPACE,
        seeds = [DEBIT_SEED, &usage.epoch.to_le_bytes(), agent_launch.agent.as_ref()], bump)]
    pub receipt: Box<Account<'info, DebitReceipt>>,
    #[account(mut, seeds = [COMPUTE_SEED, agent_launch.agent.as_ref()], bump = agent_launch.compute_bump)]
    pub compute_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut)]
    pub compute_sink: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = line_token_program)]
    pub line_mint: Box<InterfaceAccount<'info, Mint>>,
    pub line_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawCompute<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = line_mint)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    /// The agent's current registry owner (the launcher until an owner transfer; audit A1-03).
    pub owner: Signer<'info>,
    /// CHECK: PDA signer.
    #[account(seeds = [AUTHORITY_SEED], bump = launch_config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [AGENT_LAUNCH_SEED, agent_launch.mint.as_ref()], bump = agent_launch.bump)]
    pub agent_launch: Box<Account<'info, AgentLaunch>>,
    #[account(mut, seeds = [COMPUTE_SEED, agent_launch.agent.as_ref()], bump = agent_launch.compute_bump)]
    pub compute_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, token::mint = line_mint, token::authority = owner, token::token_program = line_token_program)]
    pub owner_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mint::token_program = line_token_program)]
    pub line_mint: Box<InterfaceAccount<'info, Mint>>,
    pub line_token_program: Interface<'info, TokenInterface>,
    /// The registry's `Agent` of this agent (owner program and PDA checked): its `owner` withdraws.
    #[account(seeds = [lineage_registry::AGENT_SEED, agent_launch.agent.as_ref()], bump = agent_record.bump, seeds::program = lineage_registry::ID)]
    pub agent_record: Box<Account<'info, lineage_registry::Agent>>,
}

#[derive(Accounts)]
pub struct RefreshAwake<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    #[account(mut, seeds = [AGENT_LAUNCH_SEED, agent_launch.mint.as_ref()], bump = agent_launch.bump)]
    pub agent_launch: Box<Account<'info, AgentLaunch>>,
    #[account(seeds = [COMPUTE_SEED, agent_launch.agent.as_ref()], bump = agent_launch.compute_bump)]
    pub compute_vault: Box<InterfaceAccount<'info, TokenAccount>>,
}

// ---------- events and errors ----------

#[event]
pub struct LaunchConfigSet {
    pub args: LaunchConfigArgs,
}
#[event]
pub struct PumpLaunched {
    pub agent: Pubkey,
    pub mint: Pubkey,
    pub launcher: Pubkey,
    pub bonding_curve: Pubkey,
    pub pump_creator: Pubkey,
    pub repo_id: [u8; 32],
    pub identity_mode: u8,
    pub hosted: bool,
}
#[event]
pub struct FeesCranked {
    pub agent: Pubkey,
    pub mint: Pubkey,
    pub fees: u64,
    pub to_compute: u64,
    pub to_protocol: u64,
    pub pool_fees: bool,
    pub balance: u64,
    pub awake: bool,
}
#[event]
pub struct PumpGraduated {
    pub agent: Pubkey,
    pub mint: Pubkey,
    pub pool: Pubkey,
    pub coin_creator: Pubkey,
    pub creator_is_ours: bool,
}
#[event]
pub struct UsagePosted {
    pub epoch: u64,
    pub root: [u8; 32],
}
#[event]
pub struct ComputeDebited {
    pub agent: Pubkey,
    pub epoch: u64,
    pub amount: u64,
    pub model_tokens: u64,
    pub sandbox_s: u64,
    pub balance: u64,
    pub awake: bool,
}
#[event]
pub struct ComputeWithdrawn {
    pub agent: Pubkey,
    pub amount: u64,
    pub balance: u64,
}

#[error_code]
pub enum LaunchError {
    #[msg("signer is not authorized")]
    Unauthorized,
    #[msg("launches are paused")]
    Paused,
    #[msg("invalid arguments")]
    InvalidArgs,
    #[msg("repository URL must be a canonical https URL")]
    InvalidUrl,
    #[msg("pump.fun account invalid")]
    PumpAccountInvalid,
    #[msg("wrong phase for this instruction")]
    WrongPhase,
    #[msg("bonding curve is not complete")]
    NotMigrated,
    #[msg("not the canonical PumpSwap pool of this coin quoted in $LINE")]
    PumpPoolUnexpected,
    #[msg("nothing to claim")]
    NothingToClaim,
    #[msg("no Pump create_v2 for this mint earlier in this transaction")]
    NotCreatedInThisTx,
    #[msg("curve is not quoted in $LINE")]
    PumpWrongQuote,
    #[msg("curve creator is not this agent's creator PDA")]
    PumpWrongCreator,
    #[msg("curve is not a fresh depth-1 coin without mayhem, cashback or holder rewards at Global's supply")]
    PumpCurveInvalid,
    #[msg("curve creator fee rate differs from the configured one")]
    PumpCreatorFee,
    #[msg("treasury is not the registry's")]
    WrongTreasury,
    #[msg("invalid Merkle proof")]
    BadProof,
    #[msg("hosted agents cannot withdraw compute")]
    Hosted,
    #[msg("usage epochs must be posted in sequence and not ahead of the clock")]
    UsageOrder,
    #[msg("only hosted agents are debited")]
    NotHosted,
    #[msg("debits above max_debit_per_epoch")]
    DebitCap,
    #[msg("bounty deadline outside min_ttl_s..max_ttl_s")]
    BountyTtl,
    #[msg("bounty above max_bounty_out_bps of the compute vault in this window")]
    BountyCap,
    #[msg("bounty is not open")]
    BountyClosed,
    #[msg("generation does not meet the bounty condition")]
    BountyCondition,
    #[msg("payee is not credited for this bounty")]
    BountyPayee,
    #[msg("bounty has not expired")]
    BountyNotExpired,
    #[msg("bounty is locked: an epoch was posted since it opened")]
    BountyLocked,
    #[msg("self-hosted payee above self_hosted_in_cap in this window")]
    SelfHostedCap,
    #[msg("bounty release held: the epoch's challenge window or an open challenge")]
    BountyHeld,
}
