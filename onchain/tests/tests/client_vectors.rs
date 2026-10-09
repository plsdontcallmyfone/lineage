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
    // bonded challenges (SPEC 10.8)
    v.push(ix_json("registry.set_challenge_config", &env.set_challenge_config_ix(&k(1), lr::ChallengeConfigArgs { window_s: 600, bond: 2_000_000,
        reward: 1_000_000, resolve_timeout_s: 3_600, paused: false })));
    let verdict = lr::OpenChallengeArgs { kind: lr::KIND_VERDICT, subject: [0x3c; 32], epoch: 9, claim: [0x3d; 32] };
    v.push(ix_json("registry.open_challenge.verdict", &env.open_challenge_ix(&agent, &k(12), &owner, &owner_token, verdict)));
    let slash = lr::OpenChallengeArgs { kind: lr::KIND_SLASH, subject: [0x5a; 32], epoch: 42, claim: [0x3e; 32] };
    v.push(ix_json("registry.open_challenge.slash", &env.open_challenge_ix(&agent, &k(12), &owner, &owner_token, slash)));
    let roots = lr::CorrectedRoots { payout_root: [1; 32], lineage_root: [2; 32], record_root: [3; 32], total_units_micro: 77 };
    v.push(ix_json("registry.resolve_challenge.epoch", &env.resolve_challenge_ix(&k(2), lr::KIND_EPOCH, &lr::epoch_subject(9), 9, &owner_token,
        lr::ResolveChallengeArgs { outcome: lr::CH_UPHELD, evidence: [0x4e; 32], corrected: Some(roots) }, None)));
    v.push(ix_json("registry.resolve_challenge.slash", &env.resolve_challenge_ix(&k(2), lr::KIND_SLASH, &[0x5a; 32], 42, &owner_token,
        lr::ResolveChallengeArgs { outcome: lr::CH_UPHELD, evidence: [0x4f; 32], corrected: None }, Some(agent))));
    v.push(ix_json("registry.resolve_challenge.failed", &env.resolve_challenge_ix(&k(2), lr::KIND_VERDICT, &[0x3c; 32], 9, &owner_token,
        lr::ResolveChallengeArgs { outcome: lr::CH_FAILED, evidence: [0x50; 32], corrected: None }, None)));
    v.push(ix_json("registry.expire_challenge", &env.expire_challenge_ix(lr::KIND_VERDICT, &[0x3c; 32], 9, &owner_token)));

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
        accounts: ll::accounts::WithdrawCompute { launch_config: launch_config(), owner: launcher, authority: launch_authority(), agent_launch: l.launch,
            compute_vault: l.compute_vault, owner_token: l.launcher_line, line_mint: env.line_mint, line_token_program: TOKEN,
            agent_record: agent_record(&agent) }.to_account_metas(None),
        data: ll::instruction::WithdrawCompute { amount: 5 }.data(),
    }));
    v.push(ix_json("launch.refresh_awake", &Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::RefreshAwake { launch_config: launch_config(), agent_launch: l.launch, compute_vault: l.compute_vault }.to_account_metas(None),
        data: ll::instruction::RefreshAwake {}.data(),
    }));
    // Bounties (C6).
    use ll::bounty as bt;
    let sys = anchor_lang::solana_program::system_program::ID;
    let bcfg = lpda(&[bt::BOUNTY_CONFIG_SEED]);
    v.push(ix_json("launch.set_bounty_config", &Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::SetBountyConfig { launch_config: launch_config(), bounty_config: bcfg, admin: k(1), system_program: sys }.to_account_metas(None),
        data: ll::instruction::SetBountyConfig { args: bt::BountyConfigArgs { max_bounty_out_bps: 2_000, self_hosted_in_cap: 50_000_000, window_s: 86_400,
            min_ttl_s: 3_600, max_ttl_s: 2_592_000, refund_grace_s: 3_600, min_amount: 1_000_000, paused: false } }.data(),
    }));
    let bounty = lpda(&[bt::BOUNTY_SEED, agent.as_ref(), &7u64.to_le_bytes()]);
    let bvault = lpda(&[bt::BOUNTY_VAULT_SEED, bounty.as_ref()]);
    v.push(ix_json("launch.open_bounty", &Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::OpenBounty {
            launch_config: launch_config(), bounty_config: bcfg, registry_config: registry_config(), opener: k(3), authority: launch_authority(),
            payer_launch: l.launch, payer_compute: l.compute_vault, payer_ledger: lpda(&[bt::BOUNTY_LEDGER_SEED, agent.as_ref()]), bounty,
            bounty_vault: bvault, line_mint: env.line_mint, line_token_program: TOKEN, system_program: sys, payer_record: agent_record(&agent),
        }.to_account_metas(None),
        data: ll::instruction::OpenBounty { args: bt::OpenBountyArgs { bounty_id: 7, payee: k(11), amount: 5_000_000, terms_digest: [0xaa; 32],
            condition_kind: bt::COND_TARGET, lineage_id: [0xbb; 32], condition_value: [0xcc; 32], deadline: 1_900_100_000 } }.data(),
    }));
    let payee_mint = k(14);
    v.push(ix_json("launch.release_bounty", &Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::ReleaseBounty {
            launch_config: launch_config(), bounty_config: bcfg, caller: k(5), authority: launch_authority(), bounty, bounty_vault: bvault, opener: k(3),
            registry_epoch: epoch_pda(9), payee_launch: agent_launch(&payee_mint), payee_compute: compute_vault(&k(11)),
            payee_ledger: lpda(&[bt::BOUNTY_LEDGER_SEED, k(11).as_ref()]), receipt: lpda(&[bt::BOUNTY_RECEIPT_SEED, agent.as_ref(), &[0xdd; 32]]),
            line_mint: env.line_mint, line_token_program: TOKEN, system_program: sys, challenge_config: challenge_config(), challenge_gate: challenge_gate(9),
        }.to_account_metas(None),
        data: ll::instruction::ReleaseBounty { args: bt::ReleaseArgs { leaf: [0xdd; 32], epoch: 9, gen_id: [1; 32], lineage_id: [0xbb; 32],
            candidate_commitment: [2; 32], target: vec!["t1".into(), "t2".into()], target_is_list: true,
            members: vec![bt::MemberArg { agent: k(11), role: 0, share_bps: 6_000 }, bt::MemberArg { agent: k(12), role: 1, share_bps: 4_000 }],
            finder: Some(k(13)), proof: vec![[5; 32], [6; 32]] } }.data(),
    }));
    let refund = ll::accounts::RefundBounty {
        launch_config: launch_config(), bounty_config: bcfg, authority: launch_authority(), bounty, bounty_vault: bvault, opener: k(3), payer_launch: l.launch,
        payer_compute: l.compute_vault, line_mint: env.line_mint, line_token_program: TOKEN,
    };
    v.push(ix_json("launch.refund_bounty", &Instruction { program_id: ll::ID, accounts: refund.to_account_metas(None),
        data: ll::instruction::RefundBounty {}.data() }));
    v.push(ix_json("launch.cancel_bounty", &Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::CancelBounty { r: refund, registry_config: registry_config(), signer: k(3), payer_record: agent_record(&agent) }.to_account_metas(None),
        data: ll::instruction::CancelBounty {}.data(),
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
    // a challenge config, an upheld slash challenge (the reveal slash reversed) and an open verdict challenge on epoch 4
    let admin0 = e.admin.insecure_clone();
    let ix = e.set_challenge_config_ix(&admin0.pubkey(), lr::ChallengeConfigArgs { window_s: 600, bond: 2 * ONE, reward: ONE, resolve_timeout_s: 3_600,
        paused: false });
    ok(send(&mut e.svm, &admin0, &[], vec![ix]));
    let (cowner, ctoken) = e.wallet(1_100 * ONE);
    let cagent = Keypair::new();
    e.register_verifier(&cowner, &cagent);
    let ix = e.open_challenge_ix(&cagent.pubkey(), &cagent.pubkey(), &cowner.pubkey(), &ctoken,
        lr::OpenChallengeArgs { kind: lr::KIND_SLASH, subject: sl_id, epoch: 4, claim: [0x61; 32] });
    ok(send(&mut e.svm, &cowner, &[&cagent], vec![ix]));
    let ix = e.open_challenge_ix(&cagent.pubkey(), &cagent.pubkey(), &cowner.pubkey(), &ctoken,
        lr::OpenChallengeArgs { kind: lr::KIND_VERDICT, subject: [0x62; 32], epoch: 4, claim: [0x63; 32] });
    ok(send(&mut e.svm, &cowner, &[&cagent], vec![ix]));
    let ix = e.resolve_challenge_ix(&core.pubkey(), lr::KIND_SLASH, &sl_id, 4, &ctoken,
        lr::ResolveChallengeArgs { outcome: lr::CH_UPHELD, evidence: [0x64; 32], corrected: None }, Some(agent.pubkey()));
    ok(send(&mut e.svm, &core, &[], vec![ix]));
    let ch_addr = challenge_pda(lr::KIND_SLASH, &sl_id);
    let runtime = e.runtime.insecure_clone();
    let ix = Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::PostUsage { launch_config: launch_config(), registry_config: registry_config(), runtime_authority: runtime.pubkey(),
            usage: lpda(&[ll::USAGE_SEED, &6u64.to_le_bytes()]), system_program: anchor_lang::solana_program::system_program::ID }.to_account_metas(None),
        data: ll::instruction::PostUsage { epoch: 6, root: [3; 32] }.data(),
    };
    ok(send(&mut e.svm, &runtime, &[], vec![ix]));
    // A bounty opened by the runtime for `l`, released into a second agent's compute vault with a
    // one-leaf record root (the leaf is its own root), plus a second one left open.
    use ll::bounty as bt;
    let sys = anchor_lang::solana_program::system_program::ID;
    let payee = e.launch_agent(Keypair::new(), default_launch_args());
    e.fund(&l.compute_vault, 100 * ONE);
    let admin = e.admin.insecure_clone();
    let bcfg = lpda(&[bt::BOUNTY_CONFIG_SEED]);
    let bargs = bt::BountyConfigArgs { max_bounty_out_bps: 2_000, self_hosted_in_cap: 50 * ONE, window_s: 86_400, min_ttl_s: 3_600, max_ttl_s: 2_592_000,
        refund_grace_s: 3_600, min_amount: ONE, paused: false };
    ok(send(&mut e.svm, &admin, &[], vec![Instruction { program_id: ll::ID,
        accounts: ll::accounts::SetBountyConfig { launch_config: launch_config(), bounty_config: bcfg, admin: admin.pubkey(), system_program: sys }
            .to_account_metas(None),
        data: ll::instruction::SetBountyConfig { args: bargs }.data() }]));
    let pa = l.agent.pubkey();
    let lineage = [0x4c; 32];
    let members = vec![bt::MemberArg { agent: payee.agent.pubkey(), role: bt::ROLE_AUTHOR, share_bps: 10_000 }];
    let tj = bt::target_json(&["ir".to_string()], false).unwrap();
    let leaf = bt::contribution_leaf(5, &[0x47; 32], &lineage, &tj, &[0x4b; 32], &members, None).unwrap();
    let open = |id: u64, deadline: i64| {
        let b = lpda(&[bt::BOUNTY_SEED, pa.as_ref(), &id.to_le_bytes()]);
        Instruction { program_id: ll::ID,
            accounts: ll::accounts::OpenBounty { launch_config: launch_config(), bounty_config: bcfg, registry_config: registry_config(), opener: runtime.pubkey(),
                authority: launch_authority(), payer_launch: l.launch, payer_compute: l.compute_vault, payer_ledger: lpda(&[bt::BOUNTY_LEDGER_SEED, pa.as_ref()]),
                bounty: b, bounty_vault: lpda(&[bt::BOUNTY_VAULT_SEED, b.as_ref()]), line_mint: e.line_mint, line_token_program: e.line_program,
                system_program: sys, payer_record: agent_record(&pa) }.to_account_metas(None),
            data: ll::instruction::OpenBounty { args: bt::OpenBountyArgs { bounty_id: id, payee: Pubkey::default(), amount: 3 * ONE, terms_digest: [0x7e; 32],
                condition_kind: bt::COND_TARGET, lineage_id: lineage, condition_value: bt::target_digest(&tj), deadline } }.data() }
    };
    let deadline = now(&e.svm) + 86_400;
    ok(send(&mut e.svm, &runtime, &[], vec![open(1, deadline), open(2, deadline)]));
    let ix = e.post_epoch_ix(&core.pubkey(), lr::PostEpochArgs { epoch: 5, payout_root: [0; 32], lineage_root: [0; 32], record_root: leaf, total_units_micro: 0,
        pool_amount: 0, rebate_amount: 0 });
    ok(send(&mut e.svm, &core, &[], vec![ix]));
    let b1 = lpda(&[bt::BOUNTY_SEED, pa.as_ref(), &1u64.to_le_bytes()]);
    let rcpt = lpda(&[bt::BOUNTY_RECEIPT_SEED, pa.as_ref(), &leaf]);
    let caller = funded(&mut e.svm);
    // the release waits for epoch 5's challenge window like a claim (audit A1-04)
    warp(&mut e.svm, 600);
    ok(send(&mut e.svm, &caller, &[], vec![Instruction { program_id: ll::ID,
        accounts: ll::accounts::ReleaseBounty { launch_config: launch_config(), bounty_config: bcfg, caller: caller.pubkey(), authority: launch_authority(),
            bounty: b1, bounty_vault: lpda(&[bt::BOUNTY_VAULT_SEED, b1.as_ref()]), opener: runtime.pubkey(), registry_epoch: epoch_pda(5),
            payee_launch: payee.launch, payee_compute: payee.compute_vault, payee_ledger: lpda(&[bt::BOUNTY_LEDGER_SEED, payee.agent.pubkey().as_ref()]),
            receipt: rcpt, line_mint: e.line_mint, line_token_program: e.line_program, system_program: sys, challenge_config: challenge_config(),
            challenge_gate: challenge_gate(5) }.to_account_metas(None),
        data: ll::instruction::ReleaseBounty { args: bt::ReleaseArgs { leaf, epoch: 5, gen_id: [0x47; 32], lineage_id: lineage, candidate_commitment: [0x4b; 32],
            target: vec!["ir".into()], target_is_list: false, members, finder: None, proof: vec![] } }.data() }]));
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
        {
            let c: bt::BountyConfig = read(&e.svm, &bcfg);
            json!({ "type": "BountyConfig", "address": bcfg.to_string(), "data": raw(&bcfg), "fields": {
                "maxBountyOutBps": c.max_bounty_out_bps, "selfHostedInCap": c.self_hosted_in_cap.to_string(), "windowS": c.window_s, "minTtlS": c.min_ttl_s,
                "maxTtlS": c.max_ttl_s, "refundGraceS": c.refund_grace_s, "minAmount": c.min_amount.to_string(), "paused": c.paused } })
        },
        {
            let b: bt::Bounty = read(&e.svm, &b1);
            json!({ "type": "Bounty", "address": b1.to_string(), "data": raw(&b1), "fields": {
                "payer": b.payer.to_string(), "bountyId": b.bounty_id.to_string(), "payee": b.payee.to_string(), "opener": b.opener.to_string(),
                "amount": b.amount.to_string(), "termsDigest": hex(&b.terms_digest), "conditionKind": b.condition_kind, "lineageId": hex(&b.lineage_id),
                "conditionValue": hex(&b.condition_value), "minEpoch": b.min_epoch.to_string(), "epochsPostedAtOpen": b.epochs_posted_at_open.to_string(),
                "deadline": b.deadline.to_string(), "createdAt": b.created_at.to_string(), "status": b.status, "releasedTo": b.released_to.to_string(),
                "releasedEpoch": b.released_epoch.to_string(), "leaf": hex(&b.leaf), "closedAt": b.closed_at.to_string() } })
        },
        {
            let k = lpda(&[bt::BOUNTY_LEDGER_SEED, pa.as_ref()]);
            let d: bt::BountyLedger = read(&e.svm, &k);
            json!({ "type": "BountyLedger", "address": k.to_string(), "data": raw(&k), "fields": {
                "agent": d.agent.to_string(), "outWindow": d.out_window.to_string(), "outBase": d.out_base.to_string(), "outAmount": d.out_amount.to_string(),
                "inWindow": d.in_window.to_string(), "inAmount": d.in_amount.to_string(), "openedTotal": d.opened_total.to_string(),
                "receivedTotal": d.received_total.to_string() } })
        },
        {
            let c: lr::ChallengeConfig = read(&e.svm, &challenge_config());
            json!({ "type": "ChallengeConfig", "address": challenge_config().to_string(), "data": raw(&challenge_config()), "fields": {
                "windowS": c.window_s.to_string(), "bond": c.bond.to_string(), "reward": c.reward.to_string(), "resolveTimeoutS": c.resolve_timeout_s.to_string(),
                "paused": c.paused, "open": c.open, "rewardWindow": c.reward_window.to_string(), "rewardsInWindow": c.rewards_in_window.to_string() } })
        },
        {
            let c: lr::Challenge = read(&e.svm, &ch_addr);
            json!({ "type": "Challenge", "address": ch_addr.to_string(), "data": raw(&ch_addr), "fields": {
                "kind": c.kind, "subject": hex(&c.subject), "epoch": c.epoch.to_string(), "challenger": c.challenger.to_string(), "payer": c.payer.to_string(),
                "refundToken": c.refund_token.to_string(), "bond": c.bond.to_string(), "claim": hex(&c.claim), "openedAt": c.opened_at.to_string(),
                "status": c.status, "resolvedAt": c.resolved_at.to_string(), "evidence": hex(&c.evidence), "reward": c.reward.to_string(),
                "reversed": c.reversed.to_string(), "corrected": c.corrected } })
        },
        {
            let g: lr::ChallengeGate = read(&e.svm, &challenge_gate(4));
            json!({ "type": "ChallengeGate", "address": challenge_gate(4).to_string(), "data": raw(&challenge_gate(4)), "fields": {
                "epoch": g.epoch.to_string(), "open": g.open, "opened": g.opened, "upheld": g.upheld, "corrected": g.corrected } })
        },
        {
            let r: bt::BountyReceipt = read(&e.svm, &rcpt);
            json!({ "type": "BountyReceipt", "address": rcpt.to_string(), "data": raw(&rcpt), "fields": {
                "bounty": r.bounty.to_string(), "payer": r.payer.to_string(), "leaf": hex(&r.leaf), "epoch": r.epoch.to_string(), "genId": hex(&r.gen_id),
                "payee": r.payee.to_string(), "amount": r.amount.to_string(), "releasedAt": r.released_at.to_string() } })
        },
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
    assert_eq!(doc["accounts"].as_array().unwrap().len(), 13);
}
