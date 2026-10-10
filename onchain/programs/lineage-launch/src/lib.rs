//! `lineage_launch` (SPEC 14.2): agent tokens on Meteora DBC quoted in `$LINE`. This program's
//! authority PDA is the DBC pool creator, the fee claimer and the leftover receiver, and after
//! Meteora's migration it holds the DAMM v2 position NFT whose liquidity DBC locked permanently,
//! so only this program can claim an agent token's fees. `crank_fees` / `crank_pool_fees` split
//! them between the agent's compute vault (`agent_compute_bps`) and the registry treasury
//! (`protocol_bps`).
use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use anchor_spl::token_2022::Token2022;
use anchor_spl::token_interface::{self, Burn, Mint, TokenAccount, TokenInterface, TransferChecked};
use lineage_registry::leaf;

pub mod bounty;
pub mod meteora;
pub use bounty::*;
use meteora as mt;

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
/// Longest repository URL and metadata URI `launch_agent` accepts on their own.
pub const MAX_URL: usize = 200;
pub const MAX_URI: usize = 200;
/// Most bytes of name + symbol + metadata URI + repository URL together, so that any accepted
/// `launch_agent` fits one 1,232-byte transaction with three distinct signers (launcher, agent,
/// mint) and both compute budget instructions: 1,232 minus the 1,005 bytes of everything else,
/// measured by `longest_launch_fits_one_transaction`.
pub const MAX_LAUNCH_STRINGS: usize = 227;
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
        let authority = ctx.accounts.authority.key();
        let view = mt::check_dbc_config(&ctx.accounts.dbc_config, &ctx.accounts.line_mint.key(), &ctx.accounts.line_token_program.key(), &authority)?;
        let c = &mut ctx.accounts.launch_config;
        c.line_mint = ctx.accounts.line_mint.key();
        c.line_token_program = ctx.accounts.line_token_program.key();
        c.bump = ctx.bumps.launch_config;
        c.authority_bump = ctx.bumps.authority;
        c.usage_epochs_posted = 0;
        c.last_usage_epoch = 0;
        c.usage_anchor = 0;
        c.usage_anchor_ts = 0;
        apply_args(c, &args, ctx.accounts.dbc_config.key(), &view);
        emit!(LaunchConfigSet { args, dbc_config: c.dbc_config });
        Ok(())
    }

    /// Admin: every field (a new DBC config is checked the same way as at initialize).
    pub fn set_launch_config(ctx: Context<SetLaunchConfig>, args: LaunchConfigArgs) -> Result<()> {
        args.validate()?;
        let c = &ctx.accounts.launch_config;
        let authority = Pubkey::create_program_address(&[AUTHORITY_SEED, &[c.authority_bump]], &crate::ID).map_err(|_| error!(LaunchError::Unauthorized))?;
        let view = mt::check_dbc_config(&ctx.accounts.dbc_config, &c.line_mint, &c.line_token_program, &authority)?;
        let key = ctx.accounts.dbc_config.key();
        let c = &mut ctx.accounts.launch_config;
        apply_args(c, &args, key, &view);
        emit!(LaunchConfigSet { args, dbc_config: key });
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

    /// The launcher creates an agent token: DBC pool on the configured config (creator and fee
    /// claimer = our authority PDA), the agent's compute vault, the `AgentLaunch` record, and the
    /// registry's `Agent` through `register_launched`. The agent key co-signs: one agent per key,
    /// and nobody can launch a token for a key they do not hold.
    pub fn launch_agent(ctx: Context<LaunchAgent>, args: LaunchArgs) -> Result<()> {
        let c = &ctx.accounts.launch_config;
        require!(!c.paused, LaunchError::Paused);
        require!(!args.name.is_empty() && args.name.len() <= 32 && !args.symbol.is_empty() && args.symbol.len() <= 10 && args.uri.len() <= MAX_URI,
            LaunchError::InvalidArgs);
        require!(args.name.len() + args.symbol.len() + args.uri.len() + args.repo_url.len() <= MAX_LAUNCH_STRINGS, LaunchError::InvalidArgs);
        require!(args.identity_mode <= IDENTITY_APP, LaunchError::InvalidArgs);
        check_canonical_url(args.repo_url.as_bytes())?;
        let authority = ctx.accounts.authority.key();
        mt::check_dbc_config(&ctx.accounts.dbc_config, &c.line_mint, &c.line_token_program, &authority)?;
        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[c.authority_bump]];
        mt::dbc_initialize_pool(mt::DbcInitAccounts {
            config: &ctx.accounts.dbc_config,
            pool_authority: &ctx.accounts.dbc_pool_authority,
            creator: &ctx.accounts.authority,
            base_mint: &ctx.accounts.agent_mint,
            quote_mint: &ctx.accounts.line_mint.to_account_info(),
            pool: &ctx.accounts.dbc_pool,
            base_vault: &ctx.accounts.dbc_base_vault,
            quote_vault: &ctx.accounts.dbc_quote_vault,
            payer: &ctx.accounts.launcher.to_account_info(),
            token_quote_program: &ctx.accounts.line_token_program.to_account_info(),
            token_program: &ctx.accounts.token_2022_program.to_account_info(),
            system_program: &ctx.accounts.system_program.to_account_info(),
            event_authority: &ctx.accounts.dbc_event_authority,
            program: &ctx.accounts.dbc_program,
        }, &args.name, &args.symbol, &args.uri, &[seeds])?;
        let pool = mt::read_dbc_pool(&ctx.accounts.dbc_pool)?;
        require!(pool.config == ctx.accounts.dbc_config.key() && pool.creator == authority && pool.base_mint == ctx.accounts.agent_mint.key()
            && pool.base_vault == ctx.accounts.dbc_base_vault.key() && pool.quote_vault == ctx.accounts.dbc_quote_vault.key(),
            LaunchError::MeteoraAccountInvalid);

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
                mint: ctx.accounts.agent_mint.key(),
                hosted: args.hosted,
            },
        )?;

        let l = &mut ctx.accounts.agent_launch;
        l.agent = ctx.accounts.agent.key();
        l.mint = ctx.accounts.agent_mint.key();
        l.launcher = ctx.accounts.launcher.key();
        l.repo_id = leaf::repo_id(args.repo_url.as_bytes());
        l.repo_url = args.repo_url;
        l.identity_mode = args.identity_mode;
        l.hosted = args.hosted;
        l.dbc_config = ctx.accounts.dbc_config.key();
        l.dbc_pool = ctx.accounts.dbc_pool.key();
        l.damm_pool = Pubkey::default();
        l.position = Pubkey::default();
        l.position_nft_account = Pubkey::default();
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
        emit!(AgentLaunched { agent: l.agent, mint: l.mint, launcher: l.launcher, dbc_pool: l.dbc_pool, repo_id: l.repo_id,
            identity_mode: l.identity_mode, hosted: l.hosted });
        Ok(())
    }

    /// Anyone, before or after graduation: claims the DBC partner fees (and the partner's surplus
    /// once the curve overshoots its own config's threshold) into the agent's compute vault and
    /// moves `protocol_bps` of them to the registry treasury. compute = floor(fees x
    /// agent_compute_bps / 10,000), protocol = the rest. Fees and surplus left on the curve when
    /// Meteora migrates stay claimable here after `graduate`.
    pub fn crank_fees(ctx: Context<CrankFees>) -> Result<()> {
        let c = &ctx.accounts.launch_config;
        require!(!c.paused, LaunchError::Paused);
        let pool = mt::read_dbc_pool(&ctx.accounts.dbc_pool)?;
        let threshold = mt::dbc_config_threshold(&ctx.accounts.dbc_config)?;
        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[c.authority_bump]];
        let (base_mint, quote_mint) = (ctx.accounts.agent_mint.to_account_info(), ctx.accounts.line_mint.to_account_info());
        let (t22, ltp) = (ctx.accounts.token_2022_program.to_account_info(), ctx.accounts.line_token_program.to_account_info());
        let (base_dest, quote_dest) = (ctx.accounts.authority_agent_token.to_account_info(), ctx.accounts.compute_vault.to_account_info());
        let a = mt::DbcClaimAccounts {
            pool_authority: &ctx.accounts.dbc_pool_authority,
            config: &ctx.accounts.dbc_config,
            pool: &ctx.accounts.dbc_pool,
            base_destination: &base_dest,
            quote_destination: &quote_dest,
            base_vault: &ctx.accounts.dbc_base_vault,
            quote_vault: &ctx.accounts.dbc_quote_vault,
            base_mint: &base_mint,
            quote_mint: &quote_mint,
            fee_claimer: &ctx.accounts.authority,
            token_base_program: &t22,
            token_quote_program: &ltp,
            event_authority: &ctx.accounts.dbc_event_authority,
            program: &ctx.accounts.dbc_program,
        };
        let before = ctx.accounts.compute_vault.amount;
        mt::dbc_claim_trading_fee(&a, &[seeds])?;
        if pool.quote_reserve > threshold && pool.is_partner_withdraw_surplus == 0 && pool.migration_progress >= 1 {
            mt::dbc_partner_withdraw_surplus(&a, &[seeds])?;
        }
        ctx.accounts.compute_vault.reload()?;
        let fees = ctx.accounts.compute_vault.amount.checked_sub(before).ok_or(LaunchError::CustodyMismatch)?;
        require!(fees > 0, LaunchError::NothingToClaim);
        split_fees(&ctx.accounts.launch_config, &mut ctx.accounts.agent_launch, &mut ctx.accounts.compute_vault, &ctx.accounts.treasury,
            &ctx.accounts.line_mint, &ctx.accounts.line_token_program, &ctx.accounts.authority, fees, false)
    }

    /// Anyone, once, after Meteora's migration: records the DAMM v2 pool and DBC's migration
    /// position, whose NFT our authority holds and whose liquidity is all permanently locked.
    /// Anyone can hand our authority a position NFT, so holding it proves nothing; DBC's
    /// migration position is told apart by size: it must hold a strict majority of all the
    /// liquidity permanently locked in the pool. A forged dust position fails that, and a third
    /// party can only displace the migration position by locking more liquidity than it holds
    /// and giving it to us (see `repoint_position`), which only adds to the agent's fees.
    pub fn graduate(ctx: Context<Graduate>) -> Result<()> {
        graduate_checked(ctx.accounts, true)
    }

    /// Admin escape hatch: `graduate` without the majority rule, for a pool where a third party
    /// permanently locked more liquidity than DBC's migration and kept the NFT. Every other
    /// check is the same (our authority holds the position, all of it permanently locked).
    pub fn graduate_by_admin(ctx: Context<GraduateByAdmin>) -> Result<()> {
        graduate_checked(&mut ctx.accounts.g, false)
    }

    /// Anyone, after graduation: moves `crank_pool_fees` to another position on the same pool
    /// that our authority holds, fully permanently locked, with strictly more locked liquidity
    /// than the recorded one. Crank the recorded position first; its later fees stay unclaimed.
    pub fn repoint_position(ctx: Context<RepointPosition>) -> Result<()> {
        let l = &ctx.accounts.agent_launch;
        require!(l.graduated, LaunchError::WrongPhase);
        let current = mt::read_damm_position(&ctx.accounts.current_position)?;
        let locked = held_locked_position(&ctx.accounts.position, &ctx.accounts.position_nft_account, &l.damm_pool, &ctx.accounts.authority.key())?;
        require!(locked > current.permanent_locked_liquidity, LaunchError::NotMigrationPosition);
        let l = &mut ctx.accounts.agent_launch;
        l.position = ctx.accounts.position.key();
        l.position_nft_account = ctx.accounts.position_nft_account.key();
        emit!(Graduated { agent: l.agent, mint: l.mint, damm_pool: l.damm_pool, position: l.position, locked_liquidity: locked });
        Ok(())
    }

    /// Anyone, after graduation: claims the locked position's DAMM v2 fees and splits the `$LINE`
    /// part like `crank_fees`. Any agent tokens the position paid are burned (the program never
    /// keeps agent tokens).
    pub fn crank_pool_fees(ctx: Context<CrankPoolFees>) -> Result<()> {
        let c = &ctx.accounts.launch_config;
        require!(!c.paused, LaunchError::Paused);
        require!(ctx.accounts.agent_launch.graduated, LaunchError::WrongPhase);
        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[c.authority_bump]];
        let before_line = ctx.accounts.compute_vault.amount;
        let before_agent = ctx.accounts.authority_agent_token.amount;
        let (am, lm) = (ctx.accounts.agent_mint.to_account_info(), ctx.accounts.line_mint.to_account_info());
        let (t22, ltp) = (ctx.accounts.token_2022_program.to_account_info(), ctx.accounts.line_token_program.to_account_info());
        let (da, db) = (ctx.accounts.authority_agent_token.to_account_info(), ctx.accounts.compute_vault.to_account_info());
        mt::damm_claim_position_fee(&mt::DammClaimAccounts {
            pool_authority: &ctx.accounts.damm_pool_authority,
            pool: &ctx.accounts.damm_pool,
            position: &ctx.accounts.position,
            dest_a: &da,
            dest_b: &db,
            token_a_vault: &ctx.accounts.damm_token_a_vault,
            token_b_vault: &ctx.accounts.damm_token_b_vault,
            token_a_mint: &am,
            token_b_mint: &lm,
            nft_account: &ctx.accounts.position_nft_account,
            owner: &ctx.accounts.authority,
            token_a_program: &t22,
            token_b_program: &ltp,
            event_authority: &ctx.accounts.damm_event_authority,
            program: &ctx.accounts.damm_program,
        }, &[seeds])?;
        ctx.accounts.compute_vault.reload()?;
        ctx.accounts.authority_agent_token.reload()?;
        let fees = ctx.accounts.compute_vault.amount.checked_sub(before_line).ok_or(LaunchError::CustodyMismatch)?;
        let stray = ctx.accounts.authority_agent_token.amount.checked_sub(before_agent).ok_or(LaunchError::CustodyMismatch)?;
        require!(fees + stray > 0, LaunchError::NothingToClaim);
        if stray > 0 {
            token_interface::burn(CpiContext::new_with_signer(t22, Burn { mint: am, from: da, authority: ctx.accounts.authority.to_account_info() },
                &[seeds]), stray)?;
        }
        if fees == 0 {
            return Ok(());
        }
        split_fees(&ctx.accounts.launch_config, &mut ctx.accounts.agent_launch, &mut ctx.accounts.compute_vault, &ctx.accounts.treasury,
            &ctx.accounts.line_mint, &ctx.accounts.line_token_program, &ctx.accounts.authority, fees, true)
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

fn graduate_checked(a: &mut Graduate, majority: bool) -> Result<()> {
    let l = &a.agent_launch;
    require!(!l.graduated, LaunchError::WrongPhase);
    let st = mt::read_dbc_pool(&a.dbc_pool)?;
    require!(st.is_migrated == 1 && st.migration_progress == mt::DBC_MIGRATION_CREATED_POOL, LaunchError::NotMigrated);
    let pool = mt::read_damm_pool(&a.damm_pool)?;
    let line_mint = a.launch_config.line_mint;
    require!(pool.token_a_mint == l.mint && pool.token_b_mint == line_mint && pool.creator == mt::DBC_POOL_AUTHORITY, LaunchError::DammPoolUnexpected);
    mt::check_dbc_only_damm_config(&a.damm_config)?;
    require_keys_eq!(a.damm_pool.key(), mt::damm_pool_address(&a.damm_config.key(), &pool.token_a_mint, &pool.token_b_mint),
        LaunchError::DammPoolUnexpected);
    let locked = held_locked_position(&a.position, &a.position_nft_account, &a.damm_pool.key(),
        &a.authority.key())?;
    require!(!majority || locked > pool.permanent_lock_liquidity / 2, LaunchError::NotMigrationPosition);
    let l = &mut a.agent_launch;
    l.graduated = true;
    l.damm_pool = a.damm_pool.key();
    l.position = a.position.key();
    l.position_nft_account = a.position_nft_account.key();
    emit!(Graduated { agent: l.agent, mint: l.mint, damm_pool: l.damm_pool, position: l.position, locked_liquidity: locked });
    Ok(())
}

/// A DAMM v2 position on `pool` whose NFT `authority` holds (DAMM v2's NFT account PDA, a
/// Token-2022 account holding the one NFT) with all its liquidity permanently locked; returns
/// that liquidity.
fn held_locked_position(position: &AccountInfo, nft_account: &AccountInfo, pool: &Pubkey, authority: &Pubkey) -> Result<u128> {
    use anchor_spl::token_2022::spl_token_2022::{extension::StateWithExtensions, state::Account as T22Account};
    let p = mt::read_damm_position(position)?;
    require!(p.pool == *pool, LaunchError::DammPositionInvalid);
    require_keys_eq!(nft_account.key(), mt::position_nft_account(&p.nft_mint), LaunchError::DammPositionInvalid);
    require_keys_eq!(*nft_account.owner, anchor_spl::token_2022::ID, LaunchError::DammPositionInvalid);
    let data = nft_account.try_borrow_data()?;
    let acct = StateWithExtensions::<T22Account>::unpack(&data).map_err(|_| error!(LaunchError::DammPositionInvalid))?;
    require!(acct.base.mint == p.nft_mint && acct.base.owner == *authority && acct.base.amount == 1, LaunchError::DammPositionInvalid);
    require!(p.unlocked_liquidity == 0 && p.vested_liquidity == 0 && p.permanent_locked_liquidity > 0, LaunchError::DammPositionInvalid);
    Ok(p.permanent_locked_liquidity)
}

#[allow(clippy::too_many_arguments)]
fn split_fees<'info>(c: &LaunchConfig, l: &mut AgentLaunch, compute_vault: &mut Box<InterfaceAccount<'info, TokenAccount>>,
    treasury: &InterfaceAccount<'info, TokenAccount>, line_mint: &InterfaceAccount<'info, Mint>, token_program: &Interface<'info, TokenInterface>,
    authority: &UncheckedAccount<'info>, fees: u64, pool_fees: bool) -> Result<()> {
    let to_compute = (fees as u128 * c.agent_compute_bps as u128 / BPS as u128) as u64;
    let to_protocol = fees - to_compute;
    if to_protocol > 0 {
        let seeds: &[&[u8]] = &[AUTHORITY_SEED, &[c.authority_bump]];
        token_interface::transfer_checked(
            CpiContext::new_with_signer(token_program.to_account_info(), TransferChecked {
                from: compute_vault.to_account_info(),
                mint: line_mint.to_account_info(),
                to: treasury.to_account_info(),
                authority: authority.to_account_info(),
            }, &[seeds]),
            to_protocol,
            line_mint.decimals,
        )?;
    }
    compute_vault.reload()?;
    l.fees_claimed = l.fees_claimed.saturating_add(fees);
    l.to_compute = l.to_compute.saturating_add(to_compute);
    l.to_protocol = l.to_protocol.saturating_add(to_protocol);
    update_awake(l, compute_vault.amount, c);
    emit!(FeesCranked { agent: l.agent, mint: l.mint, fees, to_compute, to_protocol, pool_fees, balance: compute_vault.amount, awake: l.awake });
    Ok(())
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

fn apply_args(c: &mut LaunchConfig, a: &LaunchConfigArgs, dbc_config: Pubkey, view: &mt::DbcConfigView) {
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
    c.dbc_config = dbc_config;
    c.migration_quote_threshold = view.migration_quote_threshold;
    c.sqrt_start_price = view.sqrt_start_price;
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
}
impl LaunchConfigArgs {
    fn validate(&self) -> Result<()> {
        require!(self.agent_compute_bps as u64 + self.protocol_bps as u64 == BPS, LaunchError::InvalidArgs);
        require!(self.sleep_threshold <= self.wake_threshold, LaunchError::InvalidArgs);
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
    /// The one DBC config launches use; its curve is the launch curve.
    pub dbc_config: Pubkey,
    pub agent_compute_bps: u16,
    pub protocol_bps: u16,
    pub sleep_threshold: u64,
    pub wake_threshold: u64,
    /// Read from the DBC config when it was set (for display; DBC enforces it).
    pub migration_quote_threshold: u64,
    pub sqrt_start_price: u128,
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
    pub dbc_config: Pubkey,
    pub dbc_pool: Pubkey,
    pub damm_pool: Pubkey,
    pub position: Pubkey,
    pub position_nft_account: Pubkey,
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
pub struct LaunchArgs {
    pub name: String,
    pub symbol: String,
    pub uri: String,
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
    /// CHECK: checked by `check_dbc_config`.
    pub dbc_config: UncheckedAccount<'info>,
    pub line_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetLaunchConfig<'info> {
    #[account(mut, seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = admin @ LaunchError::Unauthorized)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    pub admin: Signer<'info>,
    /// CHECK: checked by `check_dbc_config`.
    pub dbc_config: UncheckedAccount<'info>,
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
pub struct LaunchAgent<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = line_mint, has_one = dbc_config)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    /// CHECK: PDA signer (DBC creator and fee claimer).
    #[account(seeds = [AUTHORITY_SEED], bump = launch_config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub launcher: Signer<'info>,
    pub agent: Signer<'info>,
    /// CHECK: fresh keypair; DBC creates the Token-2022 mint.
    #[account(mut)]
    pub agent_mint: Signer<'info>,
    #[account(mint::token_program = line_token_program)]
    pub line_mint: Box<InterfaceAccount<'info, Mint>>,
    /// CHECK: the configured DBC config (has_one), re-checked in the handler.
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: created by DBC.
    #[account(mut)]
    pub dbc_pool: UncheckedAccount<'info>,
    /// CHECK: created by DBC.
    #[account(mut)]
    pub dbc_base_vault: UncheckedAccount<'info>,
    /// CHECK: created by DBC.
    #[account(mut)]
    pub dbc_quote_vault: UncheckedAccount<'info>,
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
    /// CHECK: fixed address.
    #[account(address = mt::DBC_POOL_AUTHORITY)]
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = mt::DBC_EVENT_AUTHORITY)]
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = mt::DBC_PROGRAM_ID)]
    pub dbc_program: UncheckedAccount<'info>,
    pub line_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

/// The registry's treasury token account: PDA ["treasury"] of the registry program.
fn is_registry_treasury(_c: &LaunchConfig, key: &Pubkey) -> bool {
    Pubkey::find_program_address(&[lineage_registry::TREASURY_SEED], &lineage_registry::ID).0 == *key
}

#[derive(Accounts)]
pub struct CrankFees<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = line_mint)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    /// CHECK: PDA signer.
    #[account(seeds = [AUTHORITY_SEED], bump = launch_config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [AGENT_LAUNCH_SEED, agent_launch.mint.as_ref()], bump = agent_launch.bump, has_one = dbc_config, has_one = dbc_pool)]
    pub agent_launch: Box<Account<'info, AgentLaunch>>,
    /// CHECK: has_one.
    pub dbc_config: UncheckedAccount<'info>,
    /// CHECK: has_one; read with owner and discriminator checks.
    #[account(mut)]
    pub dbc_pool: UncheckedAccount<'info>,
    /// CHECK: DBC checks it against the pool.
    #[account(mut)]
    pub dbc_base_vault: UncheckedAccount<'info>,
    /// CHECK: DBC checks it against the pool.
    #[account(mut)]
    pub dbc_quote_vault: UncheckedAccount<'info>,
    #[account(address = agent_launch.mint)]
    pub agent_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = line_token_program)]
    pub line_mint: Box<InterfaceAccount<'info, Mint>>,
    /// The authority's agent-token ATA (DBC's base destination; receives nothing here).
    #[account(mut, associated_token::mint = agent_mint, associated_token::authority = authority, associated_token::token_program = token_2022_program)]
    pub authority_agent_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [COMPUTE_SEED, agent_launch.agent.as_ref()], bump = agent_launch.compute_bump)]
    pub compute_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, constraint = is_registry_treasury(&launch_config, &treasury.key()) @ LaunchError::WrongTreasury)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: fixed address.
    #[account(address = mt::DBC_POOL_AUTHORITY)]
    pub dbc_pool_authority: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = mt::DBC_EVENT_AUTHORITY)]
    pub dbc_event_authority: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = mt::DBC_PROGRAM_ID)]
    pub dbc_program: UncheckedAccount<'info>,
    pub line_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct Graduate<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    /// CHECK: PDA (holder of the position NFT).
    #[account(seeds = [AUTHORITY_SEED], bump = launch_config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [AGENT_LAUNCH_SEED, agent_launch.mint.as_ref()], bump = agent_launch.bump, has_one = dbc_pool)]
    pub agent_launch: Box<Account<'info, AgentLaunch>>,
    /// CHECK: has_one; read with checks.
    pub dbc_pool: UncheckedAccount<'info>,
    /// CHECK: read with owner, discriminator, size and address checks.
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: read with owner, discriminator and size checks.
    pub position: UncheckedAccount<'info>,
    /// CHECK: DAMM v2's NFT account PDA for the position, held by the authority (checked).
    pub position_nft_account: UncheckedAccount<'info>,
    /// CHECK: must be a DBC-only DAMM v2 config (checked).
    pub damm_config: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct GraduateByAdmin<'info> {
    pub g: Graduate<'info>,
    #[account(address = g.launch_config.admin @ LaunchError::Unauthorized)]
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct RepointPosition<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    /// CHECK: PDA (holder of the position NFTs).
    #[account(seeds = [AUTHORITY_SEED], bump = launch_config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [AGENT_LAUNCH_SEED, agent_launch.mint.as_ref()], bump = agent_launch.bump)]
    pub agent_launch: Box<Account<'info, AgentLaunch>>,
    /// CHECK: the recorded position (address), read with owner, discriminator and size checks.
    #[account(address = agent_launch.position)]
    pub current_position: UncheckedAccount<'info>,
    /// CHECK: read with owner, discriminator and size checks.
    pub position: UncheckedAccount<'info>,
    /// CHECK: DAMM v2's NFT account PDA for the position, held by the authority (checked).
    pub position_nft_account: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct CrankPoolFees<'info> {
    #[account(seeds = [LAUNCH_CONFIG_SEED], bump = launch_config.bump, has_one = line_mint)]
    pub launch_config: Box<Account<'info, LaunchConfig>>,
    /// CHECK: PDA signer.
    #[account(seeds = [AUTHORITY_SEED], bump = launch_config.authority_bump)]
    pub authority: UncheckedAccount<'info>,
    #[account(mut, seeds = [AGENT_LAUNCH_SEED, agent_launch.mint.as_ref()], bump = agent_launch.bump, has_one = damm_pool, has_one = position,
        has_one = position_nft_account)]
    pub agent_launch: Box<Account<'info, AgentLaunch>>,
    /// CHECK: has_one; DAMM v2 checks vaults and mints against it.
    pub damm_pool: UncheckedAccount<'info>,
    /// CHECK: has_one.
    #[account(mut)]
    pub position: UncheckedAccount<'info>,
    /// CHECK: has_one.
    pub position_nft_account: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 checks it against the pool.
    #[account(mut)]
    pub damm_token_a_vault: UncheckedAccount<'info>,
    /// CHECK: DAMM v2 checks it against the pool.
    #[account(mut)]
    pub damm_token_b_vault: UncheckedAccount<'info>,
    #[account(mut, address = agent_launch.mint)]
    pub agent_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mint::token_program = line_token_program)]
    pub line_mint: Box<InterfaceAccount<'info, Mint>>,
    #[account(mut, associated_token::mint = agent_mint, associated_token::authority = authority, associated_token::token_program = token_2022_program)]
    pub authority_agent_token: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, seeds = [COMPUTE_SEED, agent_launch.agent.as_ref()], bump = agent_launch.compute_bump)]
    pub compute_vault: Box<InterfaceAccount<'info, TokenAccount>>,
    #[account(mut, constraint = is_registry_treasury(&launch_config, &treasury.key()) @ LaunchError::WrongTreasury)]
    pub treasury: Box<InterfaceAccount<'info, TokenAccount>>,
    /// CHECK: fixed address.
    #[account(address = mt::DAMM_POOL_AUTHORITY)]
    pub damm_pool_authority: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = mt::DAMM_EVENT_AUTHORITY)]
    pub damm_event_authority: UncheckedAccount<'info>,
    /// CHECK: fixed address.
    #[account(address = mt::DAMM_V2_PROGRAM_ID)]
    pub damm_program: UncheckedAccount<'info>,
    pub line_token_program: Interface<'info, TokenInterface>,
    pub token_2022_program: Program<'info, Token2022>,
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
    pub dbc_config: Pubkey,
}
#[event]
pub struct AgentLaunched {
    pub agent: Pubkey,
    pub mint: Pubkey,
    pub launcher: Pubkey,
    pub dbc_pool: Pubkey,
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
pub struct Graduated {
    pub agent: Pubkey,
    pub mint: Pubkey,
    pub damm_pool: Pubkey,
    pub position: Pubkey,
    pub locked_liquidity: u128,
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
    #[msg("DBC config does not meet the launch requirements")]
    DbcConfigInvalid,
    #[msg("Meteora account invalid")]
    MeteoraAccountInvalid,
    #[msg("wrong phase for this instruction")]
    WrongPhase,
    #[msg("DBC pool has not migrated")]
    NotMigrated,
    #[msg("unexpected DAMM v2 pool")]
    DammPoolUnexpected,
    #[msg("invalid DAMM v2 position")]
    DammPositionInvalid,
    #[msg("nothing to claim")]
    NothingToClaim,
    #[msg("token balance moved unexpectedly")]
    CustodyMismatch,
    #[msg("treasury is not the registry's")]
    WrongTreasury,
    #[msg("invalid Merkle proof")]
    BadProof,
    #[msg("hosted agents cannot withdraw compute")]
    Hosted,
    #[msg("position does not hold the majority of the pool's locked liquidity")]
    NotMigrationPosition,
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
