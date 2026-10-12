//! Harness for the fee routes of docs/plans/GITHUB-FEE-CLAIMS.md and the pools of
//! docs/plans/AGENT-POOLS.md: PDAs, instruction builders, the Ed25519 attestation instruction and
//! the venue account lists `pool_buy` forwards.
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::system_program;
use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::types::TransactionResult;
use solana_keypair::Keypair;
use solana_signer::Signer;

use crate::*;

pub const ED25519: Pubkey = ll::ED25519_PROGRAM_ID;

pub fn claim_config() -> Pubkey {
    lpda(&[ll::CLAIM_CONFIG_SEED])
}
pub fn fee_route(agent: &Pubkey) -> Pubkey {
    lpda(&[ll::FEE_ROUTE_SEED, agent.as_ref()])
}
pub fn gh_escrow(id: u64) -> Pubkey {
    lpda(&[ll::GH_ESCROW_SEED, &id.to_le_bytes()])
}
pub fn gh_vault(id: u64) -> Pubkey {
    lpda(&[ll::GH_VAULT_SEED, &id.to_le_bytes()])
}
pub fn pool_config() -> Pubkey {
    lpda(&[ll::POOL_CONFIG_SEED])
}
pub fn pool_pda(repo_id: &[u8; 32]) -> Pubkey {
    lpda(&[ll::POOL_SEED, repo_id])
}
pub fn pool_auth(repo_id: &[u8; 32]) -> Pubkey {
    lpda(&[ll::POOL_AUTH_SEED, repo_id])
}
pub fn pool_member(agent: &Pubkey) -> Pubkey {
    lpda(&[ll::POOL_MEMBER_SEED, agent.as_ref()])
}
pub fn cross_pda(holder: &Pubkey, target: &Pubkey) -> Pubkey {
    lpda(&[ll::CROSS_SEED, holder.as_ref(), target.as_ref()])
}

/// TEST values of the plans.
pub fn claim_args(attestor: &Pubkey) -> ll::ClaimConfigArgs {
    ll::ClaimConfigArgs { attestor: *attestor, min_bps: 1000, max_bps: 3000, change_delay_s: 600, rebind_delay_s: 120, max_attestation_ttl_s: 600, paused: false }
}
pub fn pool_args(keeper: &Pubkey) -> ll::PoolConfigArgs {
    ll::PoolConfigArgs {
        keeper: *keeper, auto_join: false, paused: false, max_members: 8, pool_fee_bps: 2000, payout_bps: 4000, buyback_bps: 4000, burn_bps: 2000,
        author_buyback_bps: 2000, buyback_per_gen_bps: 2500, burn_per_milestone_bps: 5000, cross_hold_quote: 10 * ONE, max_buy_quote: 1_000 * ONE,
    }
}

/// The Ed25519 precompile instruction for one signature by `signer` over `msg`, all inside its own data.
pub fn ed25519_ix(signer: &Keypair, msg: &[u8]) -> Instruction {
    ed25519_raw(&signer.pubkey().to_bytes(), signer.sign_message(msg).as_ref(), msg)
}
pub fn ed25519_raw(key: &[u8; 32], sig: &[u8], msg: &[u8]) -> Instruction {
    let (key_off, sig_off, msg_off) = (16u16, 48u16, 112u16);
    let mut d = vec![1u8, 0];
    for v in [sig_off, u16::MAX, key_off, u16::MAX, msg_off, msg.len() as u16, u16::MAX] {
        d.extend_from_slice(&v.to_le_bytes());
    }
    d.extend_from_slice(key);
    d.extend_from_slice(sig);
    d.extend_from_slice(msg);
    Instruction { program_id: ED25519, accounts: vec![], data: d }
}

pub fn repo_of(svm: &LiteSVM, l: &Launched) -> [u8; 32] {
    read::<ll::AgentLaunch>(svm, &l.launch).repo_id
}

/// Pump `buy_v3` accounts for `user` (the pool authority) buying `mint` with `$LINE`.
pub fn curve_buy_metas(mint: &Pubkey, quote: &Pubkey, quote_program: &Pubkey, user: &Pubkey) -> Vec<AccountMeta> {
    let mut m = pf::buy_v3_ix(mint, quote, quote_program, user, 0, 0).accounts;
    for a in m.iter_mut() {
        a.is_signer = false;
    }
    m
}
pub fn amm_buy_metas(pool: &Pubkey, mint: &Pubkey, quote: &Pubkey, user: &Pubkey) -> Vec<AccountMeta> {
    let mut m = pf::amm_buy_v2_ix(pool, mint, quote, user, 0, 0).accounts;
    for a in m.iter_mut() {
        a.is_signer = false;
    }
    m
}

impl Env {
    pub fn set_features_ix(&self, admin: &Pubkey, features: u8) -> Instruction {
        Instruction {
            program_id: ll::ID,
            accounts: ll::accounts::SetLaunchConfig { launch_config: launch_config(), admin: *admin }.to_account_metas(None),
            data: ll::instruction::SetFeatures { features }.data(),
        }
    }
    pub fn set_features(&mut self, features: u8) {
        let admin = self.admin.insecure_clone();
        let ix = self.set_features_ix(&admin.pubkey(), features);
        ok(send(&mut self.svm, &admin, &[], vec![ix]));
    }
    pub fn set_claim_config_ix(&self, admin: &Pubkey, args: ll::ClaimConfigArgs) -> Instruction {
        Instruction {
            program_id: ll::ID,
            accounts: ll::accounts::SetClaimConfig { launch_config: launch_config(), admin: *admin, claim_config: claim_config(), system_program: system_program::ID }
                .to_account_metas(None),
            data: ll::instruction::SetClaimConfig { args }.data(),
        }
    }
    pub fn set_pool_config_ix(&self, admin: &Pubkey, args: ll::PoolConfigArgs) -> Instruction {
        Instruction {
            program_id: ll::ID,
            accounts: ll::accounts::SetPoolConfig { launch_config: launch_config(), admin: *admin, pool_config: pool_config(), system_program: system_program::ID }
                .to_account_metas(None),
            data: ll::instruction::SetPoolConfig { args }.data(),
        }
    }
    pub fn set_fee_route_ix(&self, owner: &Pubkey, l: &Launched, github_id: u64, bps: u16) -> Instruction {
        Instruction {
            program_id: ll::ID,
            accounts: ll::accounts::SetFeeRoute {
                launch_config: launch_config(), claim_config: claim_config(), owner: *owner, agent_launch: l.launch, agent_record: agent_record(&l.agent.pubkey()),
                fee_route: fee_route(&l.agent.pubkey()), claim_escrow: gh_escrow(github_id), escrow_vault: gh_vault(github_id), authority: launch_authority(),
                line_mint: self.line_mint, line_token_program: self.line_program, system_program: system_program::ID,
            }.to_account_metas(None),
            data: ll::instruction::SetFeeRoute { github_id, bps }.data(),
        }
    }
    pub fn apply_fee_route_ix(&self, agent: &Pubkey) -> Instruction {
        Instruction {
            program_id: ll::ID,
            accounts: ll::accounts::ApplyFeeRoute { claim_config: claim_config(), fee_route: fee_route(agent) }.to_account_metas(None),
            data: ll::instruction::ApplyFeeRoute {}.data(),
        }
    }
    pub fn gh_claim_ix(&self, wallet: &Pubkey, wallet_token: &Pubkey, github_id: u64, ceiling: u64, expires_at: i64) -> Instruction {
        Instruction {
            program_id: ll::ID,
            accounts: ll::accounts::ClaimGithubFees {
                launch_config: launch_config(), claim_config: claim_config(), wallet: *wallet, claim_escrow: gh_escrow(github_id), escrow_vault: gh_vault(github_id),
                wallet_token: *wallet_token, authority: launch_authority(), line_mint: self.line_mint, line_token_program: self.line_program,
                instructions: anchor_lang::solana_program::sysvar::instructions::ID,
            }.to_account_metas(None),
            data: ll::instruction::ClaimGithubFees { ceiling, expires_at }.data(),
        }
    }
    /// The trailing accounts `crank_pump_fees` needs for this agent's route and membership.
    pub fn route_metas(&self, l: &Launched) -> Vec<AccountMeta> {
        let la: ll::AgentLaunch = read(&self.svm, &l.launch);
        let lc: ll::LaunchConfig = read(&self.svm, &launch_config());
        let active = la.routes & lc.features;
        let mut m = vec![];
        if active & ll::ROUTE_GITHUB != 0 {
            let r: ll::FeeRoute = read(&self.svm, &fee_route(&la.agent));
            m.extend([AccountMeta::new(fee_route(&la.agent), false), AccountMeta::new(gh_escrow(r.github_id), false), AccountMeta::new(gh_vault(r.github_id), false)]);
        }
        if active & ll::ROUTE_POOL != 0 {
            let p = pool_pda(&la.repo_id);
            m.extend([AccountMeta::new_readonly(pool_config(), false), AccountMeta::new(pool_member(&la.agent), false), AccountMeta::new(p, false),
                AccountMeta::new(ata(&pool_auth(&la.repo_id), &self.line_mint, &self.line_program), false)]);
        }
        m
    }
    /// A keeper's crank with the agent's route accounts appended.
    pub fn crank_routed(&mut self, l: &Launched) -> TransactionResult {
        let k = funded(&mut self.svm);
        let line = self.line_mint;
        let mut ixs = vec![cu(800_000), create_ata_ix(&k.pubkey(), &l.pump_creator, &line, &self.line_program),
            pf::sweep_creator_fee_ix(&k.pubkey(), &l.mint, &line, &l.pump_creator), pf::collect_creator_fee_v2_ix(&l.pump_creator, &line)];
        let pool = pf::pool_of(&l.mint, &line);
        if self.svm.get_account(&pool).is_some() {
            ixs.extend(pf::amm_sweep_and_collect_ixs(&k.pubkey(), &pool, &line, &l.pump_creator));
        }
        let mut ix = self.crank_ix(l);
        ix.accounts.extend(self.route_metas(l));
        ixs.push(ix);
        send_unchecked(&mut self.svm, &k, &[], ixs)
    }
    pub fn join_ix(&self, signer: &Pubkey, l: &Launched, repo_id: &[u8; 32], existing: &[Pubkey]) -> Instruction {
        let auth = pool_auth(repo_id);
        let mut accounts = ll::accounts::JoinPool {
            launch_config: launch_config(), pool_config: pool_config(), signer: *signer, agent_launch: l.launch, agent_record: agent_record(&l.agent.pubkey()),
            pool: pool_pda(repo_id), pool_member: pool_member(&l.agent.pubkey()), pool_auth: auth, pool_vault: ata(&auth, &self.line_mint, &self.line_program),
            line_mint: self.line_mint, line_token_program: self.line_program, associated_token_program: ATA_PROGRAM, system_program: system_program::ID,
        }.to_account_metas(None);
        accounts.extend(existing.iter().map(|a| AccountMeta::new(pool_member(a), false)));
        Instruction { program_id: ll::ID, accounts, data: ll::instruction::JoinPool {}.data() }
    }
    pub fn settle_ix(&self, keeper: &Pubkey, repo_id: &[u8; 32], members: &[Pubkey], args: ll::PoolSettleArgs) -> Instruction {
        let mut accounts = ll::accounts::PoolSettle {
            launch_config: launch_config(), pool_config: pool_config(), keeper: *keeper, registry_config: registry_config(), pool: pool_pda(repo_id),
        }.to_account_metas(None);
        accounts.extend(members.iter().map(|a| AccountMeta::new(pool_member(a), false)));
        Instruction { program_id: ll::ID, accounts, data: ll::instruction::PoolSettle { args }.data() }
    }
    pub fn pay_ix(&self, repo_id: &[u8; 32], l: &Launched) -> Instruction {
        let auth = pool_auth(repo_id);
        Instruction {
            program_id: ll::ID,
            accounts: ll::accounts::PoolPay {
                launch_config: launch_config(), pool: pool_pda(repo_id), pool_auth: auth, pool_vault: ata(&auth, &self.line_mint, &self.line_program),
                member: pool_member(&l.agent.pubkey()), agent_launch: l.launch, compute_vault: l.compute_vault, line_mint: self.line_mint,
                line_token_program: self.line_program,
            }.to_account_metas(None),
            data: ll::instruction::PoolPay {}.data(),
        }
    }
    /// `pool_buy` of `target`'s token on its curve.
    pub fn pool_buy_ix(&self, keeper: &Pubkey, repo_id: &[u8; 32], target: &Launched, kind: u8, args: ll::PoolBuyArgs) -> Instruction {
        let auth = pool_auth(repo_id);
        let mut accounts = ll::accounts::PoolBuy {
            launch_config: launch_config(), pool_config: pool_config(), keeper: *keeper, pool: pool_pda(repo_id), pool_auth: auth,
            pool_vault: ata(&auth, &self.line_mint, &self.line_program), target: pool_member(&target.agent.pubkey()), target_mint: target.mint,
            pool_token: ata(&auth, &target.mint, &T22), token_program: T22, venue_program: if args.venue == ll::VENUE_AMM { pf::PUMP_AMM } else { pf::PUMP },
        }.to_account_metas(None);
        accounts.extend(if args.venue == ll::VENUE_AMM { amm_buy_metas(&pf::pool_of(&target.mint, &self.line_mint), &target.mint, &self.line_mint, &auth) }
            else { curve_buy_metas(&target.mint, &self.line_mint, &self.line_program, &auth) });
        Instruction { program_id: ll::ID, accounts, data: ll::instruction::PoolBuy { kind, args }.data() }
    }
    pub fn cross_buy_ix(&self, keeper: &Pubkey, repo_id: &[u8; 32], holder: &Launched, target: &Launched, args: ll::PoolBuyArgs) -> Instruction {
        let auth = pool_auth(repo_id);
        let mut accounts = ll::accounts::PoolCrossBuy {
            launch_config: launch_config(), pool_config: pool_config(), keeper: *keeper, pool: pool_pda(repo_id), pool_auth: auth,
            pool_vault: ata(&auth, &self.line_mint, &self.line_program), holder: pool_member(&holder.agent.pubkey()),
            target: pool_member(&target.agent.pubkey()), cross: cross_pda(&holder.agent.pubkey(), &target.agent.pubkey()), target_mint: target.mint,
            pool_token: ata(&auth, &target.mint, &T22), token_program: T22, venue_program: pf::PUMP, system_program: system_program::ID,
        }.to_account_metas(None);
        accounts.extend(curve_buy_metas(&target.mint, &self.line_mint, &self.line_program, &auth));
        Instruction { program_id: ll::ID, accounts, data: ll::instruction::PoolCrossBuy { args }.data() }
    }
    /// Posts registry epoch `n` with empty roots (settlements need a posted epoch).
    pub fn post_empty_epoch(&mut self, n: u64) {
        let core = self.core.insecure_clone();
        let ix = self.post_epoch_ix(&core.pubkey(), lr::PostEpochArgs { epoch: n, payout_root: [0; 32], lineage_root: [0; 32], total_units_micro: 0,
            pool_amount: 0, rebate_amount: 0, record_root: [0; 32] });
        ok(send(&mut self.svm, &core, &[], vec![ix]));
    }
}
