//! Cross-checks for the TypeScript client (packages/chain): every instruction built here with fixed
//! keys, and live account bytes from a LiteSVM run with the fields the programs' own types decode.
//! `UPDATE_VECTORS=1 cargo test --test client_vectors` rewrites tests/fixtures/client-vectors.json;
//! without it the instruction vectors must equal the committed file (the account snapshots use
//! fresh keys every run, so only their presence is checked).
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{InstructionData, ToAccountMetas};
use lineage_onchain_tests::*;
use serde_json::{json, Value};

fn b64(bytes: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for c in bytes.chunks(3) {
        let n = (c[0] as u32) << 16 | (*c.get(1).unwrap_or(&0) as u32) << 8 | *c.get(2).unwrap_or(&0) as u32;
        for i in 0..4 {
            if i <= c.len() {
                out.push(T[(n >> (18 - 6 * i) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn ix_json(name: &str, ix: &Instruction) -> Value {
    json!({
        "name": name,
        "program": ix.program_id.to_string(),
        "accounts": ix.accounts.iter().map(|m| json!([m.pubkey.to_string(), m.is_signer, m.is_writable])).collect::<Vec<_>>(),
        "data": b64(&ix.data),
    })
}
fn k(n: u8) -> Pubkey {
    seeded(n).pubkey()
}

fn instruction_vectors() -> Vec<Value> {
    let env = Env {
        svm: LiteSVM::new(),
        admin: seeded(1),
        core: seeded(2),
        runtime: seeded(3),
        line_mint: k(4),
        line_program: TOKEN,
        line_holder: k(5),
        compute_sink: k(10),
        dbc_config: k(8),
    };
    let (owner, agent, mint, launcher) = (k(5), k(6), k(7), k(9));
    let mut p = test_params();
    p.register_burn = 1_234_567;
    let cargs = lr::ConfigArgs { admin: k(1), core_authority: k(2), launch_program: ll::ID, params: p, max_rebate_per_epoch: 123_456 };
    let owner_token = ata(&owner, &env.line_mint, &TOKEN);
    let mut v = vec![
        ix_json("registry.initialize", &registry_init_ix(k(1), cargs, env.line_mint, TOKEN)),
        ix_json("registry.set_config", &env.admin_ix(&k(1), lr::instruction::SetConfig { args: cargs }.data())),
        ix_json("registry.pause", &env.admin_ix(&k(1), lr::instruction::Pause { paused: true }.data())),
        ix_json("registry.register", &env.register_ix(&owner, &agent, &owner_token)),
        ix_json("registry.update_agent", &env.owner_agent_ix(&owner, &agent, lr::instruction::UpdateAgent { operator: [3; 32], capabilities: [4; 32] }.data())),
        ix_json("registry.bond", &env.bond_ix(&owner, &agent, &owner_token, 5_000_000_000)),
        ix_json("registry.request_unbond", &env.owner_agent_ix(&owner, &agent, lr::instruction::RequestUnbond { amount: 77 }.data())),
        ix_json("registry.withdraw_unbonded", &env.withdraw_unbonded_ix(&owner, &agent, &owner_token)),
        ix_json("registry.slash", &env.slash_ix(&k(2), &agent, lr::OFFENCE_MINORITY, 42, [0x5a; 32])),
        ix_json("registry.set_epoch_cursor", &env.admin_ix(&k(1), lr::instruction::SetEpochCursor { epochs_posted: 3, last_epoch: 9, anchor: 7,
            anchor_ts: 1_900_000_123 }.data())),
        ix_json("registry.migrate_config", &Instruction {
            program_id: lr::ID,
            accounts: lr::accounts::MigrateConfig { config: registry_config(), admin: k(1), system_program: anchor_lang::solana_program::system_program::ID }
                .to_account_metas(None),
            data: lr::instruction::MigrateConfig { max_rebate_per_epoch: 654_321 }.data(),
        }),
        ix_json("registry.split", &env.split_ix()),
        ix_json("registry.post_epoch", &env.post_epoch_ix(&k(2), lr::PostEpochArgs { epoch: 9, payout_root: [1; 32], lineage_root: [2; 32], record_root: [3; 32],
            total_units_micro: 3_500_000, pool_amount: 10, rebate_amount: 20 })),
    ];
    v.push(ix_json("registry.rotate_agent_key", &env.rotate_agent_key_ix(&owner, &agent, &k(12))));
    v.push(ix_json("registry.revoke_agent_key", &env.owner_agent_ix(&owner, &agent, lr::instruction::RevokeAgentKey {}.data())));
    v.push(ix_json("registry.set_profile", &env.set_profile_ix(&k(12), &agent, [0xab; 32], 7)));
    v.push(ix_json("registry.propose_owner", &env.owner_agent_ix(&owner, &agent, lr::instruction::ProposeOwner { new_owner: k(13) }.data())));
    v.push(ix_json("registry.accept_owner", &env.accept_owner_ix(&k(13), &agent)));
    v.push(ix_json("registry.migrate_agent", &migrate_agent_ix(&k(1), &agent)));
    v.push(ix_json("registry.migrate_epoch", &migrate_epoch_ix(&k(1), 9)));
    let claim = lr::ClaimArgs { agent, dest_kind: 0, wallet: Pubkey::default(), amount: 99, leaf: [8; 32], proof: vec![[5; 32], [6; 32]] };
    v.push(ix_json("registry.claim.agent_wallet", &env.claim_ix(&owner, 9, claim.clone(), Some(agent_record(&agent)), &owner_token)));
    let claim2 = lr::ClaimArgs { dest_kind: 2, wallet: k(11), ..claim };
    v.push(ix_json("registry.claim.wallet", &env.claim_ix(&owner, 9, claim2, None, &ata(&k(11), &env.line_mint, &TOKEN))));

    let largs = ll::LaunchConfigArgs { admin: k(1), runtime_authority: k(3), compute_sink: k(10), agent_compute_bps: 7000,
        protocol_bps: 3000, sleep_threshold: 1, wake_threshold: 2, paused: false, max_debit_per_epoch: 4_242 };
    v.push(ix_json("launch.initialize_launch", &launch_init_ix(k(1), largs, env.line_mint, TOKEN, env.dbc_config)));
    v.push(ix_json("launch.set_launch_config", &set_launch_config_ix(k(1), largs, env.dbc_config)));
    v.push(ix_json("launch.launch_agent", &env.launch_ix(&launcher, &agent, &mint, default_launch_args())));
    let dbc_pool = dbc_pool_of(&env.dbc_config, &mint, &env.line_mint);
    let l = Launched {
        agent: seeded(6),
        launcher: seeded(9),
        launcher_line: ata(&launcher, &env.line_mint, &TOKEN),
        mint,
        launch: agent_launch(&mint),
        dbc_pool,
        dbc_base_vault: pda_of(&[b"token_vault", mint.as_ref(), dbc_pool.as_ref()], &DBC),
        dbc_quote_vault: pda_of(&[b"token_vault", env.line_mint.as_ref(), dbc_pool.as_ref()], &DBC),
        compute_vault: compute_vault(&agent),
        authority_agent_token: ata(&launch_authority(), &mint, &T22),
    };
    v.push(ix_json("launch.crank_fees", &env.crank_fees_ix(&l)));
    let (damm_pool, position, nft, va, vb) = (k(12), k(13), k(14), k(15), k(16));
    v.push(ix_json("launch.graduate", &Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::Graduate { launch_config: launch_config(), authority: launch_authority(), agent_launch: l.launch, dbc_pool,
            damm_pool, position, position_nft_account: nft, damm_config: DAMM_DYNAMIC_CONFIG }.to_account_metas(None),
        data: ll::instruction::Graduate {}.data(),
    }));
    v.push(ix_json("launch.graduate_by_admin", &Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::GraduateByAdmin {
            g: ll::accounts::Graduate { launch_config: launch_config(), authority: launch_authority(), agent_launch: l.launch, dbc_pool,
                damm_pool, position, position_nft_account: nft, damm_config: DAMM_DYNAMIC_CONFIG },
            admin: k(1),
        }.to_account_metas(None),
        data: ll::instruction::GraduateByAdmin {}.data(),
    }));
    v.push(ix_json("launch.repoint_position", &Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::RepointPosition { launch_config: launch_config(), authority: launch_authority(), agent_launch: l.launch,
            current_position: position, position: k(15), position_nft_account: k(16) }.to_account_metas(None),
        data: ll::instruction::RepointPosition {}.data(),
    }));
    v.push(ix_json("launch.migrate_launch_config", &Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::MigrateLaunchConfig { launch_config: launch_config(), admin: k(1),
            system_program: anchor_lang::solana_program::system_program::ID }.to_account_metas(None),
        data: ll::instruction::MigrateLaunchConfig { max_debit_per_epoch: 8_888 }.data(),
    }));
    v.push(ix_json("launch.crank_pool_fees", &Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::CrankPoolFees {
            launch_config: launch_config(), authority: launch_authority(), agent_launch: l.launch, damm_pool, position, position_nft_account: nft,
            damm_token_a_vault: va, damm_token_b_vault: vb, agent_mint: mint, line_mint: env.line_mint, authority_agent_token: l.authority_agent_token,
            compute_vault: l.compute_vault, treasury: treasury(), damm_pool_authority: ll::meteora::DAMM_POOL_AUTHORITY,
            damm_event_authority: ll::meteora::DAMM_EVENT_AUTHORITY, damm_program: DAMM, line_token_program: TOKEN, token_2022_program: T22,
        }.to_account_metas(None),
        data: ll::instruction::CrankPoolFees {}.data(),
    }));
    let epoch = 3u64;
    v.push(ix_json("launch.post_usage", &Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::PostUsage { launch_config: launch_config(), registry_config: registry_config(), runtime_authority: k(3),
            usage: lpda(&[ll::USAGE_SEED, &epoch.to_le_bytes()]), system_program: anchor_lang::solana_program::system_program::ID }.to_account_metas(None),
        data: ll::instruction::PostUsage { epoch, root: [9; 32] }.data(),
    }));
    v.push(ix_json("launch.debit_compute", &Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::DebitCompute {
            launch_config: launch_config(), runtime_authority: k(3), authority: launch_authority(), usage: lpda(&[ll::USAGE_SEED, &epoch.to_le_bytes()]),
            agent_launch: l.launch, receipt: lpda(&[ll::DEBIT_SEED, &epoch.to_le_bytes(), agent.as_ref()]), compute_vault: l.compute_vault,
            compute_sink: k(10), line_mint: env.line_mint, line_token_program: TOKEN, system_program: anchor_lang::solana_program::system_program::ID,
        }.to_account_metas(None),
        data: ll::instruction::DebitCompute { args: ll::DebitArgs { amount: 150_000, model_tokens: 81_234, sandbox_s: 412, proof: vec![[1; 32]] } }.data(),
    }));
    v.push(ix_json("launch.withdraw_compute", &Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::WithdrawCompute { launch_config: launch_config(), launcher, authority: launch_authority(), agent_launch: l.launch,
            compute_vault: l.compute_vault, launcher_token: l.launcher_line, line_mint: env.line_mint, line_token_program: TOKEN }.to_account_metas(None),
        data: ll::instruction::WithdrawCompute { amount: 5 }.data(),
    }));
    v.push(ix_json("launch.refresh_awake", &Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::RefreshAwake { launch_config: launch_config(), agent_launch: l.launch, compute_vault: l.compute_vault }.to_account_metas(None),
        data: ll::instruction::RefreshAwake {}.data(),
    }));
    v
}

fn account_snapshots() -> Vec<Value> {
    let mut e = setup(LineKind::Pump);
    let (owner, owner_token) = e.wallet(20_000 * ONE);
    let agent = Keypair::new();
    e.register_verifier(&owner, &agent);
    let ix = e.bond_ix(&owner.pubkey(), &agent.pubkey(), &owner_token, 6_000 * ONE);
    ok(send(&mut e.svm, &owner, &[], vec![ix]));
    let ix = e.owner_agent_ix(&owner.pubkey(), &agent.pubkey(), anchor_lang::InstructionData::data(&lr::instruction::RequestUnbond { amount: 1_000 * ONE }));
    ok(send(&mut e.svm, &owner, &[], vec![ix]));
    let l = e.launch_agent(Keypair::new(), default_launch_args());
    e.fund(&reserve_vault(), 1_000);
    let core = e.core.insecure_clone();
    let ix = e.post_epoch_ix(&core.pubkey(), lr::PostEpochArgs { epoch: 4, payout_root: [1; 32], lineage_root: [2; 32], record_root: [3; 32], total_units_micro: 3,
        pool_amount: 0, rebate_amount: 1_000 });
    ok(send(&mut e.svm, &core, &[], vec![ix]));
    // Agent v2 fields with values: a rotation, a profile and a pending owner transfer.
    let new_key = Keypair::new();
    let ix = e.rotate_agent_key_ix(&owner.pubkey(), &agent.pubkey(), &new_key.pubkey());
    ok(send(&mut e.svm, &owner, &[&new_key], vec![ix]));
    let ix = e.set_profile_ix(&new_key.pubkey(), &agent.pubkey(), [0xcd; 32], 2);
    ok(send(&mut e.svm, &owner, &[&new_key], vec![ix]));
    let ix = e.owner_agent_ix(&owner.pubkey(), &agent.pubkey(), lr::instruction::ProposeOwner { new_owner: k(13) }.data());
    ok(send(&mut e.svm, &owner, &[], vec![ix]));
    let sl_id = [0x77; 32];
    let ix = e.slash_ix(&core.pubkey(), &agent.pubkey(), lr::OFFENCE_REVEAL, 4, sl_id);
    ok(send(&mut e.svm, &core, &[], vec![ix]));
    let runtime = e.runtime.insecure_clone();
    let ix = Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::PostUsage { launch_config: launch_config(), registry_config: registry_config(), runtime_authority: runtime.pubkey(),
            usage: lpda(&[ll::USAGE_SEED, &6u64.to_le_bytes()]), system_program: anchor_lang::solana_program::system_program::ID }.to_account_metas(None),
        data: ll::instruction::PostUsage { epoch: 6, root: [3; 32] }.data(),
    };
    ok(send(&mut e.svm, &runtime, &[], vec![ix]));
    let raw = |key: &Pubkey| b64(&e.svm.get_account(key).unwrap().data);
    let c = e.rconfig();
    let a = e.agent(&agent.pubkey());
    let ep: lr::Epoch = read(&e.svm, &epoch_pda(4));
    let lc: ll::LaunchConfig = read(&e.svm, &launch_config());
    let la: ll::AgentLaunch = read(&e.svm, &l.launch);
    let sr: lr::SlashReceipt = read(&e.svm, &slash_receipt(&sl_id));
    vec![
        json!({ "type": "Config", "data": raw(&registry_config()), "fields": {
            "admin": c.admin.to_string(), "coreAuthority": c.core_authority.to_string(), "launchProgram": c.launch_program.to_string(),
            "mint": c.mint.to_string(), "tokenProgram": c.token_program.to_string(), "paused": c.paused, "epochsPosted": c.epochs_posted.to_string(),
            "lastEpoch": c.last_epoch.to_string(), "registerBurn": c.params.register_burn.to_string(), "reserveBps": c.params.reserve_bps,
            "poolBps": c.params.pool_bps, "unbondCooldownS": c.params.unbond_cooldown_s.to_string(), "quorum": c.params.quorum,
            "authorRewardTo": c.params.author_reward_to, "finderShareBps": c.params.finder_share_bps, "epochLengthS": c.params.epoch_length_s,
            "maxRebatePerEpoch": c.max_rebate_per_epoch.to_string(), "epochAnchor": c.epoch_anchor.to_string(),
            "epochAnchorTs": c.epoch_anchor_ts.to_string() } }),
        json!({ "type": "Agent", "data": raw(&agent_record(&agent.pubkey())), "fields": {
            "agent": a.agent.to_string(), "owner": a.owner.to_string(), "kind": a.kind, "hosted": a.hosted, "burned": a.burned.to_string(),
            "bond": a.bond.to_string(), "unbondAmount": a.unbond_amount.to_string(), "unbondReadyAt": a.unbond_ready_at.to_string(),
            "operator": hex(&a.operator), "capabilities": hex(&a.capabilities), "registeredAt": a.registered_at.to_string(),
            "signingKey": a.signing_key.to_string(), "keySeq": a.key_seq, "keyChangedAt": a.key_changed_at.to_string(),
            "profileDigest": hex(&a.profile_digest), "profileSeq": a.profile_seq, "pendingOwner": a.pending_owner.to_string(),
            "ownerSince": a.owner_since.to_string() } }),
        json!({ "type": "Epoch", "data": raw(&epoch_pda(4)), "fields": {
            "epoch": ep.epoch.to_string(), "payoutRoot": hex(&ep.payout_root), "lineageRoot": hex(&ep.lineage_root), "totalPayable": ep.total_payable.to_string(),
            "recordRoot": hex(&ep.record_root), "rebateAmount": ep.rebate_amount.to_string(), "claimedAmount": ep.claimed_amount.to_string() } }),
        json!({ "type": "LaunchConfig", "data": raw(&launch_config()), "fields": {
            "admin": lc.admin.to_string(), "runtimeAuthority": lc.runtime_authority.to_string(), "lineMint": lc.line_mint.to_string(),
            "dbcConfig": lc.dbc_config.to_string(), "agentComputeBps": lc.agent_compute_bps, "protocolBps": lc.protocol_bps,
            "sleepThreshold": lc.sleep_threshold.to_string(), "wakeThreshold": lc.wake_threshold.to_string(),
            "migrationQuoteThreshold": lc.migration_quote_threshold.to_string(), "sqrtStartPrice": lc.sqrt_start_price.to_string(), "paused": lc.paused,
            "registryProgram": lc.registry_program.to_string(), "maxDebitPerEpoch": lc.max_debit_per_epoch.to_string(),
            "usageEpochsPosted": lc.usage_epochs_posted.to_string(), "lastUsageEpoch": lc.last_usage_epoch.to_string(),
            "usageAnchor": lc.usage_anchor.to_string(), "usageAnchorTs": lc.usage_anchor_ts.to_string() } }),
        json!({ "type": "AgentLaunch", "data": raw(&l.launch), "fields": {
            "agent": la.agent.to_string(), "mint": la.mint.to_string(), "launcher": la.launcher.to_string(), "repoId": hex(&la.repo_id),
            "repoUrl": la.repo_url, "identityMode": la.identity_mode, "hosted": la.hosted, "dbcPool": la.dbc_pool.to_string(), "graduated": la.graduated,
            "awake": la.awake, "createdAt": la.created_at.to_string() } }),
        json!({ "type": "SlashReceipt", "address": slash_receipt(&sl_id).to_string(), "data": raw(&slash_receipt(&sl_id)), "fields": {
            "slashId": hex(&sr.slash_id), "agent": sr.agent.to_string(), "offence": sr.offence, "epoch": sr.epoch.to_string(),
            "amount": sr.amount.to_string(), "slashedAt": sr.slashed_at.to_string() } }),
    ]
}

#[test]
fn client_vectors() {
    let path = manifest("fixtures/client-vectors.json");
    let ixs = instruction_vectors();
    if std::env::var("UPDATE_VECTORS").is_ok() {
        let doc = json!({
            "_note": "Generated by onchain/tests/tests/client_vectors.rs (UPDATE_VECTORS=1); read by packages/chain tests.",
            "seeds": "keys are solana keypair_from_seed([n; 32]) for n = 1..16",
            "instructions": ixs,
            "accounts": account_snapshots(),
        });
        std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
        return;
    }
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("run with UPDATE_VECTORS=1 once")).unwrap();
    assert_eq!(doc["instructions"], Value::Array(ixs), "instruction vectors changed: rerun with UPDATE_VECTORS=1 and the packages/chain tests");
    assert_eq!(doc["accounts"].as_array().unwrap().len(), 6);
}
