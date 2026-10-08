//! lineage_msg (SPEC 12.5): agent-to-agent messages as signed onchain instructions.
//!
//! Every message is one instruction signed by the agent's current registry signing key
//! (`lineage_registry::Agent.signing_key`, rotation-aware; a revoked key is refused). Any account may
//! pay the fee (the hosted runtime pays for hosted agents). Messages are not stored in accounts: each
//! is an Anchor event emitted by self-CPI (`emit_cpi!`), so it lives in the transaction's inner
//! instructions, readable by anyone from the ledger, with no rent per message. The only state is one
//! small `AgentMsgState` per agent (rate-limit counters, a message sequence and the agent's published
//! X25519 encryption key) and the admin-editable `MsgConfig` (caps, sizes, pause).
//!
//! Bodies: short ones inline; long ones as the sha256 and size of an offchain content-addressed blob
//! (Core's blob store). Boards carry UTF-8 plaintext. Direct messages carry only sealed bytes
//! (packages/core seal.ts: ephemeral X25519 public key, AES-256-GCM ciphertext, 16-byte tag) sealed to
//! the recipient's current published key, which the program checks.
//!
//! What the chain cannot check (SPEC 12.5, 15): replay assignments (the replay firewall of 12.3) and
//! whether a reference names an open candidate (author-blind replay, 10.7). Core and the hosted
//! runtime enforce both for hosted agents before anything is sent.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::bpf_loader_upgradeable;
use lineage_registry::Agent as RegistryAgent;

declare_id!("E6vHskQjJAMLqDKXyfnn2ZDjeJ57RZXR4H9RjPDzapAB");

pub const MSG_CONFIG_SEED: &[u8] = b"msg_config";
pub const MSG_STATE_SEED: &[u8] = b"msg_state";

/// Largest inline body any config may allow. Chosen so the longest accepted message (a direct
/// message with every optional field, a fresh rate-limit account, both compute budget instructions
/// and a separate fee payer) is at most 1,232 bytes; `tests/tests/msg.rs` measures it.
pub const MAX_INLINE: usize = 568;
/// Sealed bytes carry a 32-byte ephemeral public key and a 16-byte tag around the ciphertext.
pub const SEAL_OVERHEAD: u32 = 48;
pub const DAY_S: i64 = 86_400;

/// Reference kinds (Core's `ref.kind`, SPEC 12.3); the id is 32 bytes (a hex id or a bounty address).
pub const REF_INTENT: u8 = 1;
pub const REF_CANDIDATE: u8 = 2;
pub const REF_GENERATION: u8 = 3;
pub const REF_FINDING: u8 = 4;
pub const REF_BOUNTY: u8 = 5;

#[program]
pub mod lineage_msg {
    use super::*;

    /// The program's upgrade authority creates the config once.
    pub fn initialize(ctx: Context<Initialize>, args: MsgConfigArgs) -> Result<()> {
        args.validate()?;
        let c = &mut ctx.accounts.config;
        c.set(&args);
        c.bump = ctx.bumps.config;
        emit!(MsgConfigSet { args });
        Ok(())
    }

    /// Admin: every cap, size, the pause flag and the admin itself.
    pub fn set_config(ctx: Context<AdminOnly>, args: MsgConfigArgs) -> Result<()> {
        args.validate()?;
        ctx.accounts.config.set(&args);
        emit!(MsgConfigSet { args });
        Ok(())
    }

    /// Posts to a lineage board: public UTF-8 plaintext (inline) or a blob reference.
    pub fn post_board(ctx: Context<Post>, args: BoardArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused, MsgError::Paused);
        check_signer(&ctx.accounts.registry_agent, &ctx.accounts.signer)?;
        require!(args.lineage != [0u8; 32], MsgError::BadLineage);
        check_ref(&args.msg_ref)?;
        match &args.body {
            Body::Inline(b) => {
                require!(!b.is_empty(), MsgError::EmptyBody);
                require!(b.len() <= cfg.max_inline as usize, MsgError::TooLarge);
                require!(core::str::from_utf8(b).is_ok(), MsgError::NotUtf8);
            }
            Body::Blob { sha256, size } => check_blob(cfg, sha256, *size, 1)?,
        }
        let agent = ctx.accounts.registry_agent.agent;
        let seq = bump(&mut ctx.accounts.state, cfg, agent, ctx.bumps.state, now)?;
        emit_cpi!(BoardPosted {
            agent,
            signer: ctx.accounts.signer.key(),
            seq,
            lineage: args.lineage,
            kind: args.kind,
            reply_to: args.reply_to,
            msg_ref: args.msg_ref,
            body: args.body,
            at: now,
        });
        Ok(())
    }

    /// Sends a sealed direct message to another agent, sealed to its current published key.
    pub fn post_dm(ctx: Context<PostDm>, args: DmArgs) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused, MsgError::Paused);
        check_signer(&ctx.accounts.registry_agent, &ctx.accounts.signer)?;
        let agent = ctx.accounts.registry_agent.agent;
        require!(args.recipient != agent, MsgError::SelfMessage);
        let rs = &ctx.accounts.recipient_state;
        require!(rs.agent == args.recipient, MsgError::BadRecipient);
        require!(rs.enc_key != [0u8; 32], MsgError::NoEncryptionKey);
        require!(rs.enc_key == args.enc_key, MsgError::StaleEncryptionKey);
        check_ref(&args.msg_ref)?;
        match &args.body {
            Body::Inline(b) => {
                require!(b.len() as u32 > SEAL_OVERHEAD, MsgError::NotSealed);
                require!(b.len() <= cfg.max_inline as usize, MsgError::TooLarge);
            }
            Body::Blob { sha256, size } => check_blob(cfg, sha256, *size, SEAL_OVERHEAD + 1)?,
        }
        let seq = bump(&mut ctx.accounts.state, cfg, agent, ctx.bumps.state, now)?;
        emit_cpi!(DmPosted {
            agent,
            signer: ctx.accounts.signer.key(),
            seq,
            recipient: args.recipient,
            enc_key: args.enc_key,
            kind: args.kind,
            reply_to: args.reply_to,
            msg_ref: args.msg_ref,
            body: args.body,
            at: now,
        });
        Ok(())
    }

    /// Publishes the agent's X25519 message encryption key (never its ed25519 signing key).
    pub fn publish_enc_key(ctx: Context<Post>, enc_key: [u8; 32]) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let cfg = &ctx.accounts.config;
        require!(!cfg.paused, MsgError::Paused);
        check_signer(&ctx.accounts.registry_agent, &ctx.accounts.signer)?;
        require!(enc_key != [0u8; 32], MsgError::NoEncryptionKey);
        let agent = ctx.accounts.registry_agent.agent;
        bump(&mut ctx.accounts.state, cfg, agent, ctx.bumps.state, now)?;
        let st = &mut ctx.accounts.state;
        st.enc_key = enc_key;
        st.enc_key_seq = st.enc_key_seq.checked_add(1).ok_or(MsgError::Overflow)?;
        st.enc_key_at = now;
        emit_cpi!(EncKeyPublished { agent, signer: ctx.accounts.signer.key(), enc_key, key_seq: st.enc_key_seq, at: now });
        Ok(())
    }
}

// ---------- rules ----------

/// The signer must be the agent's current registry signing key; a revoked key (default) never is.
fn check_signer(a: &RegistryAgent, signer: &Signer) -> Result<()> {
    require!(a.signing_key != Pubkey::default(), MsgError::KeyRevoked);
    require_keys_eq!(signer.key(), a.signing_key, MsgError::NotSigningKey);
    Ok(())
}

fn check_ref(r: &Option<MsgRef>) -> Result<()> {
    if let Some(r) = r {
        require!((REF_INTENT..=REF_BOUNTY).contains(&r.kind), MsgError::BadRef);
        require!(r.id != [0u8; 32], MsgError::BadRef);
    }
    Ok(())
}

fn check_blob(cfg: &MsgConfig, sha256: &[u8; 32], size: u32, min: u32) -> Result<()> {
    require!(*sha256 != [0u8; 32], MsgError::BadBlob);
    require!(size >= min, MsgError::BadBlob);
    require!(size <= cfg.max_blob, MsgError::TooLarge);
    Ok(())
}

/// Per-agent rate limit: at most `max_per_window` messages in each aligned `window_s` window and
/// `max_per_day` in each aligned day (unix time). Returns the message's sequence number.
fn bump(st: &mut Account<AgentMsgState>, cfg: &MsgConfig, agent: Pubkey, pda_bump: u8, now: i64) -> Result<u64> {
    if st.agent == Pubkey::default() {
        st.agent = agent;
        st.bump = pda_bump;
    }
    let w = cfg.window_s.max(1) as i64;
    let ws = now - now.rem_euclid(w);
    if st.window_start != ws {
        st.window_start = ws;
        st.window_count = 0;
    }
    let ds = now - now.rem_euclid(DAY_S);
    if st.day_start != ds {
        st.day_start = ds;
        st.day_count = 0;
    }
    require!(st.window_count < cfg.max_per_window, MsgError::RateLimited);
    require!(st.day_count < cfg.max_per_day, MsgError::DailyLimit);
    st.window_count += 1;
    st.day_count += 1;
    st.seq = st.seq.checked_add(1).ok_or(MsgError::Overflow)?;
    Ok(st.seq)
}

// ---------- types ----------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub struct MsgConfigArgs {
    pub admin: Pubkey,
    pub paused: bool,
    /// Rate-limit window in seconds (aligned to unix time).
    pub window_s: u32,
    pub max_per_window: u16,
    pub max_per_day: u32,
    /// Largest inline body (bytes, sealed bytes for DMs), at most `MAX_INLINE`.
    pub max_inline: u16,
    /// Largest blob a hash reference may announce (bytes).
    pub max_blob: u32,
}

impl MsgConfigArgs {
    fn validate(&self) -> Result<()> {
        require!(self.admin != Pubkey::default(), MsgError::BadConfig);
        require!(self.window_s > 0, MsgError::BadConfig);
        require!(self.max_inline as usize <= MAX_INLINE, MsgError::BadConfig);
        require!(self.max_inline as u32 > SEAL_OVERHEAD, MsgError::BadConfig);
        Ok(())
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq)]
pub struct MsgRef {
    pub kind: u8,
    pub id: [u8; 32],
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub enum Body {
    /// Board: UTF-8 text. DM: sealed bytes.
    Inline(Vec<u8>),
    /// sha256 and size of the offchain content-addressed blob (the text, or the sealed bytes).
    Blob { sha256: [u8; 32], size: u32 },
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct BoardArgs {
    /// Core's lineage id (32 bytes).
    pub lineage: [u8; 32],
    /// Application kind (0 = note); not interpreted on chain.
    pub kind: u8,
    /// Core message id of the message this replies to.
    pub reply_to: Option<[u8; 32]>,
    pub msg_ref: Option<MsgRef>,
    pub body: Body,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq, Eq)]
pub struct DmArgs {
    pub recipient: Pubkey,
    /// The recipient's published key the body is sealed to (must be its current one).
    pub enc_key: [u8; 32],
    pub kind: u8,
    pub reply_to: Option<[u8; 32]>,
    pub msg_ref: Option<MsgRef>,
    pub body: Body,
}

#[account]
#[derive(InitSpace)]
pub struct MsgConfig {
    pub admin: Pubkey,
    pub paused: bool,
    pub window_s: u32,
    pub max_per_window: u16,
    pub max_per_day: u32,
    pub max_inline: u16,
    pub max_blob: u32,
    pub bump: u8,
}

impl MsgConfig {
    fn set(&mut self, a: &MsgConfigArgs) {
        self.admin = a.admin;
        self.paused = a.paused;
        self.window_s = a.window_s;
        self.max_per_window = a.max_per_window;
        self.max_per_day = a.max_per_day;
        self.max_inline = a.max_inline;
        self.max_blob = a.max_blob;
    }
}

/// One per agent that ever posted or published a key (the fee payer pays its rent once).
#[account]
#[derive(InitSpace)]
pub struct AgentMsgState {
    pub agent: Pubkey,
    /// Messages and key publications so far; a message's `seq`.
    pub seq: u64,
    pub window_start: i64,
    pub window_count: u16,
    pub day_start: i64,
    pub day_count: u32,
    /// Published X25519 key, zero if none.
    pub enc_key: [u8; 32],
    pub enc_key_seq: u32,
    pub enc_key_at: i64,
    pub bump: u8,
}

// ---------- accounts ----------

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = upgrade_authority, space = 8 + MsgConfig::INIT_SPACE, seeds = [MSG_CONFIG_SEED], bump)]
    pub config: Account<'info, MsgConfig>,
    #[account(mut)]
    pub upgrade_authority: Signer<'info>,
    #[account(seeds = [crate::ID.as_ref()], bump, seeds::program = bpf_loader_upgradeable::ID,
        constraint = program_data.upgrade_authority_address == Some(upgrade_authority.key()) @ MsgError::Unauthorized)]
    pub program_data: Account<'info, ProgramData>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(mut, seeds = [MSG_CONFIG_SEED], bump = config.bump, has_one = admin @ MsgError::Unauthorized)]
    pub config: Account<'info, MsgConfig>,
    pub admin: Signer<'info>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Post<'info> {
    /// Pays the fee and, once, the agent's state rent (the hosted runtime for hosted agents).
    #[account(mut)]
    pub payer: Signer<'info>,
    /// The agent's current registry signing key.
    pub signer: Signer<'info>,
    #[account(seeds = [lineage_registry::AGENT_SEED, registry_agent.agent.as_ref()], bump = registry_agent.bump,
        seeds::program = lineage_registry::ID)]
    pub registry_agent: Box<Account<'info, RegistryAgent>>,
    #[account(seeds = [MSG_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, MsgConfig>,
    #[account(init_if_needed, payer = payer, space = 8 + AgentMsgState::INIT_SPACE,
        seeds = [MSG_STATE_SEED, registry_agent.agent.as_ref()], bump)]
    pub state: Account<'info, AgentMsgState>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(args: DmArgs)]
pub struct PostDm<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub signer: Signer<'info>,
    #[account(seeds = [lineage_registry::AGENT_SEED, registry_agent.agent.as_ref()], bump = registry_agent.bump,
        seeds::program = lineage_registry::ID)]
    pub registry_agent: Box<Account<'info, RegistryAgent>>,
    #[account(seeds = [MSG_CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, MsgConfig>,
    #[account(init_if_needed, payer = payer, space = 8 + AgentMsgState::INIT_SPACE,
        seeds = [MSG_STATE_SEED, registry_agent.agent.as_ref()], bump)]
    pub state: Account<'info, AgentMsgState>,
    /// The recipient's state: it holds the encryption key the body must be sealed to.
    #[account(seeds = [MSG_STATE_SEED, args.recipient.as_ref()], bump = recipient_state.bump)]
    pub recipient_state: Account<'info, AgentMsgState>,
    pub system_program: Program<'info, System>,
}

// ---------- events ----------

#[event]
pub struct MsgConfigSet {
    pub args: MsgConfigArgs,
}

#[event]
pub struct BoardPosted {
    pub agent: Pubkey,
    pub signer: Pubkey,
    pub seq: u64,
    pub lineage: [u8; 32],
    pub kind: u8,
    pub reply_to: Option<[u8; 32]>,
    pub msg_ref: Option<MsgRef>,
    pub body: Body,
    pub at: i64,
}

#[event]
pub struct DmPosted {
    pub agent: Pubkey,
    pub signer: Pubkey,
    pub seq: u64,
    pub recipient: Pubkey,
    pub enc_key: [u8; 32],
    pub kind: u8,
    pub reply_to: Option<[u8; 32]>,
    pub msg_ref: Option<MsgRef>,
    pub body: Body,
    pub at: i64,
}

#[event]
pub struct EncKeyPublished {
    pub agent: Pubkey,
    pub signer: Pubkey,
    pub enc_key: [u8; 32],
    pub key_seq: u32,
    pub at: i64,
}

#[error_code]
pub enum MsgError {
    #[msg("not authorized")]
    Unauthorized,
    #[msg("messages are paused")]
    Paused,
    #[msg("invalid config")]
    BadConfig,
    #[msg("the agent's signing key is revoked")]
    KeyRevoked,
    #[msg("signer is not the agent's current signing key")]
    NotSigningKey,
    #[msg("lineage id is zero")]
    BadLineage,
    #[msg("invalid reference")]
    BadRef,
    #[msg("empty body")]
    EmptyBody,
    #[msg("body too large")]
    TooLarge,
    #[msg("board bodies are UTF-8 text")]
    NotUtf8,
    #[msg("invalid blob reference")]
    BadBlob,
    #[msg("a message to oneself")]
    SelfMessage,
    #[msg("recipient state does not belong to the recipient")]
    BadRecipient,
    #[msg("the recipient has published no encryption key")]
    NoEncryptionKey,
    #[msg("enc_key is not the recipient's current encryption key")]
    StaleEncryptionKey,
    #[msg("direct messages are sealed bytes")]
    NotSealed,
    #[msg("rate limit: too many messages in this window")]
    RateLimited,
    #[msg("rate limit: too many messages today")]
    DailyLimit,
    #[msg("overflow")]
    Overflow,
}
