//! lineage_registry on LiteSVM: Merkle leaves equal to the TypeScript protocol's, register (burn),
//! bond, unbond cooldown, slash and strikes, split, epoch post and claim with a root built by
//! `@lineage/protocol`, double-claim and wrong-signer refusals, pause, set_config.
use anchor_lang::InstructionData;
use lineage_onchain_tests::*;

fn fixture_leaf(f: &serde_json::Value, i: usize) -> (Pubkey, String, u64, [u8; 32], Vec<[u8; 32]>) {
    let l = &f["payout"]["leaves"][i];
    (b58_pubkey(l["agent"].as_str().unwrap()), l["dest"].as_str().unwrap().to_string(), l["amount"].as_str().unwrap().parse().unwrap(),
        hex32(l["leaf"].as_str().unwrap()), l["proof"].as_array().unwrap().iter().map(|p| hex32(p.as_str().unwrap())).collect())
}

/// (dest_kind, wallet) from a Core destination string.
fn dest_of(dest: &str) -> (u8, Pubkey) {
    if let Some(w) = dest.strip_prefix("wallet:") {
        (2, b58_pubkey(w))
    } else if dest.ends_with(":compute") {
        (1, Pubkey::default())
    } else {
        (0, Pubkey::default())
    }
}

#[test]
fn leaves_match_the_typescript_protocol() {
    let f = fixtures();
    let epoch = f["payout"]["epoch"].as_u64().unwrap();
    let root = hex32(f["payout"]["root"].as_str().unwrap());
    let n = f["payout"]["leaves"].as_array().unwrap().len();
    for i in 0..n {
        let (agent, dest, amount, leaf, proof) = fixture_leaf(&f, i);
        let (kind, wallet) = dest_of(&dest);
        let kind = [lr::leaf::Dest::AgentWallet, lr::leaf::Dest::AgentCompute, lr::leaf::Dest::Wallet][kind as usize];
        assert_eq!(lr::leaf::payout_leaf(epoch, &agent.to_bytes(), kind, &wallet.to_bytes(), amount), leaf, "payout leaf {i}");
        assert!(lr::leaf::verify_proof(&leaf, &proof, &root));
        let mut bad = proof.clone();
        bad[0][0] ^= 1;
        assert!(!lr::leaf::verify_proof(&leaf, &bad, &root));
    }
    let uepoch = f["usage"]["epoch"].as_u64().unwrap();
    let uroot = hex32(f["usage"]["root"].as_str().unwrap());
    for u in f["usage"]["leaves"].as_array().unwrap() {
        let leaf = lr::leaf::usage_leaf(uepoch, &b58_pubkey(u["agent"].as_str().unwrap()).to_bytes(), u["amount"].as_str().unwrap().parse().unwrap(),
            u["model_tokens"].as_u64().unwrap(), u["sandbox_s"].as_u64().unwrap());
        assert_eq!(leaf, hex32(u["leaf"].as_str().unwrap()));
        let proof: Vec<[u8; 32]> = u["proof"].as_array().unwrap().iter().map(|p| hex32(p.as_str().unwrap())).collect();
        assert!(lr::leaf::verify_proof(&leaf, &proof, &uroot));
    }
    assert_eq!(lr::leaf::repo_id(f["repo"]["url"].as_str().unwrap().as_bytes()), hex32(f["repo"]["repo_id"].as_str().unwrap()));
    // The fixture keys are the seeded keypairs the suites sign with.
    assert_eq!(seeded(11).pubkey(), b58_pubkey(f["keys"]["A"].as_str().unwrap()));
    assert_eq!(seeded(12).pubkey(), b58_pubkey(f["keys"]["B"].as_str().unwrap()));
    assert_eq!(seeded(13).pubkey(), b58_pubkey(f["keys"]["W"].as_str().unwrap()));
}

#[test]
fn register_bond_unbond_cooldown() {
    for kind in [LineKind::Classic, LineKind::Pump] {
        let mut e = setup(kind);
        let (owner, owner_token) = e.wallet(20_000 * ONE);
        let agent = Keypair::new();
        let supply0 = supply(&e.svm, &e.line_mint);
        e.register_verifier(&owner, &agent);
        let p = test_params();
        assert_eq!(supply(&e.svm, &e.line_mint), supply0 - p.register_burn, "register burns register_burn");
        assert_eq!(balance(&e.svm, &owner_token), 20_000 * ONE - p.register_burn);
        let a = e.agent(&agent.pubkey());
        assert_eq!((a.owner, a.kind, a.burned, a.bond, a.hosted, a.operator, a.capabilities), (owner.pubkey(), lr::KIND_VERIFIER,
            p.register_burn, 0, false, [7; 32], [9; 32]));
        assert_eq!(a.registered_at, NOW);
        // One record per agent key.
        let ix = e.register_ix(&owner.pubkey(), &agent.pubkey(), &owner_token);
        assert!(send(&mut e.svm, &owner, &[&agent], vec![ix]).is_err());
        // Not enough $LINE to burn.
        let (poor, poor_token) = e.wallet(p.register_burn - 1);
        let a2 = Keypair::new();
        let ix = e.register_ix(&poor.pubkey(), &a2.pubkey(), &poor_token);
        assert!(send(&mut e.svm, &poor, &[&a2], vec![ix]).is_err());

        // Bond, only by the owner.
        let ix = e.bond_ix(&owner.pubkey(), &agent.pubkey(), &owner_token, 6_000 * ONE);
        ok(send(&mut e.svm, &owner, &[], vec![ix]));
        let (thief, thief_token) = e.wallet(1_000 * ONE);
        let ix = e.bond_ix(&thief.pubkey(), &agent.pubkey(), &thief_token, ONE);
        rejects(send(&mut e.svm, &thief, &[], vec![ix]), "Unauthorized");
        assert_eq!(e.agent(&agent.pubkey()).bond, 6_000 * ONE);
        assert_eq!(balance(&e.svm, &bond_vault()), 6_000 * ONE);

        // Unbond: request, cooldown, withdraw.
        let ix = e.owner_agent_ix(&thief.pubkey(), &agent.pubkey(), lr::instruction::RequestUnbond { amount: ONE }.data());
        rejects(send(&mut e.svm, &thief, &[], vec![ix]), "Unauthorized");
        let ix = e.owner_agent_ix(&owner.pubkey(), &agent.pubkey(), lr::instruction::RequestUnbond { amount: 6_001 * ONE }.data());
        rejects(send(&mut e.svm, &owner, &[], vec![ix]), "InvalidAmount");
        let ix = e.withdraw_unbonded_ix(&owner.pubkey(), &agent.pubkey(), &owner_token);
        rejects(send(&mut e.svm, &owner, &[], vec![ix]), "NoUnbond");
        let ix = e.owner_agent_ix(&owner.pubkey(), &agent.pubkey(), lr::instruction::RequestUnbond { amount: 2_000 * ONE }.data());
        ok(send(&mut e.svm, &owner, &[], vec![ix]));
        let a = e.agent(&agent.pubkey());
        assert_eq!((a.unbond_amount, a.unbond_requested_at, a.unbond_ready_at), (2_000 * ONE, NOW, NOW + 600));
        warp(&mut e.svm, 599);
        let ix = e.withdraw_unbonded_ix(&owner.pubkey(), &agent.pubkey(), &owner_token);
        rejects(send(&mut e.svm, &owner, &[], vec![ix]), "Cooldown");
        warp(&mut e.svm, 1);
        let before = balance(&e.svm, &owner_token);
        // Someone else's token account is refused even by the owner signature check.
        let ix = e.withdraw_unbonded_ix(&owner.pubkey(), &agent.pubkey(), &thief_token);
        assert!(send(&mut e.svm, &owner, &[], vec![ix]).is_err());
        let ix = e.withdraw_unbonded_ix(&owner.pubkey(), &agent.pubkey(), &owner_token);
        ok(send(&mut e.svm, &owner, &[], vec![ix]));
        assert_eq!(balance(&e.svm, &owner_token), before + 2_000 * ONE);
        let a = e.agent(&agent.pubkey());
        assert_eq!((a.bond, a.unbond_amount), (4_000 * ONE, 0));
        assert_eq!(balance(&e.svm, &bond_vault()), 4_000 * ONE);
    }
}

#[test]
fn slash_strikes_and_suspension() {
    let mut e = setup(LineKind::Classic);
    let (owner, owner_token) = e.wallet(20_000 * ONE);
    let agent = Keypair::new();
    e.register_verifier(&owner, &agent);
    let ix = e.bond_ix(&owner.pubkey(), &agent.pubkey(), &owner_token, 10_000 * ONE);
    ok(send(&mut e.svm, &owner, &[], vec![ix]));
    let ix = e.owner_agent_ix(&owner.pubkey(), &agent.pubkey(), lr::instruction::RequestUnbond { amount: 9_900 * ONE }.data());
    ok(send(&mut e.svm, &owner, &[], vec![ix]));
    let core = e.core.insecure_clone();
    // Only the Core authority slashes.
    let ix = e.slash_ix(&owner.pubkey(), &agent.pubkey(), lr::OFFENCE_CANARY, 5);
    rejects(send(&mut e.svm, &owner, &[], vec![ix]), "Unauthorized");
    let ix = e.slash_ix(&core.pubkey(), &agent.pubkey(), 9, 5);
    rejects(send(&mut e.svm, &core, &[], vec![ix]), "InvalidParams");
    // Canary 25%: 2,500 to the reserve.
    let ix = e.slash_ix(&core.pubkey(), &agent.pubkey(), lr::OFFENCE_CANARY, 5);
    ok(send(&mut e.svm, &core, &[], vec![ix]));
    let a = e.agent(&agent.pubkey());
    assert_eq!((a.bond, a.slashed_total, a.strikes_in_epoch, a.suspended_through_epoch), (7_500 * ONE, 2_500 * ONE, 1, 0));
    assert_eq!(a.unbond_amount, 7_500 * ONE, "a pending unbond never exceeds the bond");
    assert_eq!(balance(&e.svm, &reserve_vault()), 2_500 * ONE);
    // Minority 5% of 7,500 = 375; reveal 2% of 7,125 = 142.5 floored.
    let ix = e.slash_ix(&core.pubkey(), &agent.pubkey(), lr::OFFENCE_MINORITY, 5);
    ok(send(&mut e.svm, &core, &[], vec![ix]));
    let ix = e.slash_ix(&core.pubkey(), &agent.pubkey(), lr::OFFENCE_REVEAL, 5);
    ok(send(&mut e.svm, &core, &[], vec![ix]));
    let a = e.agent(&agent.pubkey());
    assert_eq!(a.bond, 7_125 * ONE - 142_500_000);
    assert_eq!(a.slashed_total + a.bond, 10_000 * ONE);
    assert_eq!(balance(&e.svm, &reserve_vault()) + balance(&e.svm, &bond_vault()), 10_000 * ONE);
    // Third strike in epoch 5 (strike_limit 3) suspends through epoch 6.
    assert_eq!((a.strikes_in_epoch, a.strikes_total, a.suspended_through_epoch), (3, 3, 6));
    // An abandoned assignment strikes without slashing; a new epoch restarts the count.
    let bond = a.bond;
    let ix = e.slash_ix(&core.pubkey(), &agent.pubkey(), lr::OFFENCE_ABANDON, 6);
    ok(send(&mut e.svm, &core, &[], vec![ix]));
    let a = e.agent(&agent.pubkey());
    assert_eq!((a.bond, a.strikes_epoch, a.strikes_in_epoch, a.strikes_total, a.suspended_through_epoch), (bond, 6, 1, 4, 6));
}

#[test]
fn split_is_exact() {
    let mut e = setup(LineKind::Pump);
    let anyone = funded(&mut e.svm);
    let ix = e.split_ix();
    rejects(send(&mut e.svm, &anyone, &[], vec![ix]), "ZeroAmount");
    e.fund(&treasury(), 1_000_001);
    let ix = e.split_ix();
    ok(send(&mut e.svm, &anyone, &[], vec![ix]));
    // reserve = floor(1,000,001 x 8,000 / 10,000) = 800,000; the pool takes the rest.
    assert_eq!(balance(&e.svm, &reserve_vault()), 800_000);
    assert_eq!(balance(&e.svm, &pool_vault()), 200_001);
    assert_eq!(balance(&e.svm, &treasury()), 0);
}

fn claim_args(f: &serde_json::Value, i: usize) -> (lr::ClaimArgs, u8, Pubkey) {
    let (agent, dest, amount, leaf, proof) = fixture_leaf(f, i);
    let (dest_kind, wallet) = dest_of(&dest);
    (lr::ClaimArgs { agent, dest_kind, wallet, amount, leaf, proof }, dest_kind, agent)
}

#[test]
fn epoch_post_and_claim_with_a_typescript_root() {
    for kind in [LineKind::Classic, LineKind::Pump] {
        let mut e = setup(kind);
        let f = fixtures();
        let epoch = f["payout"]["epoch"].as_u64().unwrap();
        let root = hex32(f["payout"]["root"].as_str().unwrap());
        let total: u64 = f["payout"]["total"].as_str().unwrap().parse().unwrap();
        // A: a verifier; B: a launched agent (its compute vault exists); W: a launcher wallet.
        let (owner_a, owner_a_token) = e.wallet(10_000 * ONE);
        e.register_verifier(&owner_a, &seeded(11));
        let b = e.launch_agent(seeded(12), default_launch_args());
        let (w, w_token) = e.wallet_with(seeded(13), 0);
        let _ = w;
        let b_launcher_token = b.launcher_line;

        // Fees reach the treasury, split, then Core posts the epoch.
        e.fund(&treasury(), 10_000_000);
        let anyone = funded(&mut e.svm);
        let ix = e.split_ix();
        ok(send(&mut e.svm, &anyone, &[], vec![ix]));
        let pool_amount = 2_000_000;
        let rebate = total - pool_amount;
        let args = lr::PostEpochArgs { epoch, payout_root: root, lineage_root: [5; 32], total_units_micro: 12_500_000, pool_amount, rebate_amount: rebate };
        let core = e.core.insecure_clone();
        let ix = e.post_epoch_ix(&anyone.pubkey(), args);
        rejects(send(&mut e.svm, &anyone, &[], vec![ix]), "Unauthorized");
        let ix = e.post_epoch_ix(&core.pubkey(), args);
        ok(send(&mut e.svm, &core, &[], vec![ix]));
        assert_eq!(balance(&e.svm, &payable_vault()), total);
        assert_eq!(balance(&e.svm, &pool_vault()), 0);
        assert_eq!(balance(&e.svm, &reserve_vault()), 8_000_000 - rebate);
        let ep: lr::Epoch = read(&e.svm, &epoch_pda(epoch));
        assert_eq!((ep.payout_root, ep.lineage_root, ep.total_payable, ep.claimed_amount), (root, [5; 32], total, 0));
        // Epochs only move forward.
        let ix = e.post_epoch_ix(&core.pubkey(), lr::PostEpochArgs { epoch, ..args });
        assert!(send(&mut e.svm, &core, &[], vec![ix]).is_err());
        let ix = e.post_epoch_ix(&core.pubkey(), lr::PostEpochArgs { epoch: epoch - 1, pool_amount: 0, rebate_amount: 0, ..args });
        rejects(send(&mut e.svm, &core, &[], vec![ix]), "EpochOrder");

        let n = f["payout"]["leaves"].as_array().unwrap().len();
        let mut paid = 0u64;
        for i in 0..n {
            let (args, dest_kind, agent) = claim_args(&f, i);
            let (dest, rec) = if agent == seeded(11).pubkey() {
                (owner_a_token, Some(agent_record(&agent)))
            } else if agent == seeded(12).pubkey() {
                match dest_kind {
                    0 => (b_launcher_token, Some(agent_record(&agent))),
                    1 => (b.compute_vault, None),
                    _ => (w_token, None),
                }
            } else {
                // Not registered on chain: an `agent:<id>:wallet` leaf has no owner to pay.
                let (_, t) = e.wallet(0);
                let ix = e.claim_ix(&anyone.pubkey(), epoch, args.clone(), None, &t);
                rejects(send(&mut e.svm, &anyone, &[], vec![ix]), "BadDestination");
                continue;
            };
            // Wrong amount, tampered proof, wrong destination.
            let ix = e.claim_ix(&anyone.pubkey(), epoch, lr::ClaimArgs { amount: args.amount + 1, ..args.clone() }, rec, &dest);
            rejects(send(&mut e.svm, &anyone, &[], vec![ix]), "LeafMismatch");
            let mut bad = args.clone();
            bad.proof[0][3] ^= 0x40;
            let ix = e.claim_ix(&anyone.pubkey(), epoch, bad, rec, &dest);
            rejects(send(&mut e.svm, &anyone, &[], vec![ix]), "BadProof");
            let ix = e.claim_ix(&anyone.pubkey(), epoch, args.clone(), rec, &e.compute_sink.clone());
            rejects(send(&mut e.svm, &anyone, &[], vec![ix]), "BadDestination");
            // The real claim, by anyone: the tokens can only go to the leaf's destination.
            let before = balance(&e.svm, &dest);
            let ix = e.claim_ix(&anyone.pubkey(), epoch, args.clone(), rec, &dest);
            ok(send(&mut e.svm, &anyone, &[], vec![ix]));
            assert_eq!(balance(&e.svm, &dest), before + args.amount);
            paid += args.amount;
            // Twice is refused (the receipt PDA exists).
            let ix = e.claim_ix(&anyone.pubkey(), epoch, args.clone(), rec, &dest);
            rejects(send(&mut e.svm, &anyone, &[], vec![ix]), "already in use");
        }
        let ep: lr::Epoch = read(&e.svm, &epoch_pda(epoch));
        assert_eq!((ep.claimed_amount, ep.claims), (paid, 4));
        assert_eq!(balance(&e.svm, &payable_vault()), total - paid);

        // A later epoch whose posted total is smaller than a leaf cannot overpay.
        let args8 = lr::PostEpochArgs { epoch: epoch + 1, payout_root: root, lineage_root: [0; 32], total_units_micro: 1, pool_amount: 0, rebate_amount: 1_000 };
        let ix = e.post_epoch_ix(&core.pubkey(), args8);
        ok(send(&mut e.svm, &core, &[], vec![ix]));
        let i = (0..n).find(|i| claim_args(&f, *i).2 == seeded(11).pubkey()).unwrap();
        let (args, _, agent) = claim_args(&f, i);
        let leaf8 = lr::leaf::payout_leaf(epoch + 1, &agent.to_bytes(), lr::leaf::Dest::AgentWallet, &[0; 32], args.amount);
        let ix = e.claim_ix(&anyone.pubkey(), epoch + 1, lr::ClaimArgs { leaf: leaf8, ..args.clone() }, Some(agent_record(&agent)), &owner_a_token);
        // The epoch is part of the leaf, so epoch 7's proof does not verify in epoch 8.
        rejects(send(&mut e.svm, &anyone, &[], vec![ix]), "BadProof");
    }
}

#[test]
fn over_claim_is_refused() {
    let mut e = setup(LineKind::Classic);
    // A one-leaf tree: the root is the leaf.
    let (owner, owner_token) = e.wallet(10_000 * ONE);
    let agent = Keypair::new();
    e.register_verifier(&owner, &agent);
    let leaf = lr::leaf::payout_leaf(1, &agent.pubkey().to_bytes(), lr::leaf::Dest::AgentWallet, &[0; 32], 5_000);
    e.fund(&reserve_vault(), 4_999);
    let core = e.core.insecure_clone();
    let ix = e.post_epoch_ix(&core.pubkey(), lr::PostEpochArgs { epoch: 1, payout_root: leaf, lineage_root: [0; 32], total_units_micro: 1, pool_amount: 0,
        rebate_amount: 4_999 });
    ok(send(&mut e.svm, &core, &[], vec![ix]));
    let args = lr::ClaimArgs { agent: agent.pubkey(), dest_kind: 0, wallet: Pubkey::default(), amount: 5_000, leaf, proof: vec![] };
    let ix = e.claim_ix(&owner.pubkey(), 1, args, Some(agent_record(&agent.pubkey())), &owner_token);
    rejects(send(&mut e.svm, &owner, &[], vec![ix]), "OverClaim");
}

#[test]
fn pause_and_config_are_admin_only() {
    let mut e = setup(LineKind::Classic);
    let admin = e.admin.insecure_clone();
    let (owner, owner_token) = e.wallet(10_000 * ONE);
    let ix = e.admin_ix(&owner.pubkey(), lr::instruction::Pause { paused: true }.data());
    rejects(send(&mut e.svm, &owner, &[], vec![ix]), "Unauthorized");
    let ix = e.admin_ix(&admin.pubkey(), lr::instruction::Pause { paused: true }.data());
    ok(send(&mut e.svm, &admin, &[], vec![ix]));
    assert!(e.rconfig().paused);
    let agent = Keypair::new();
    let ix = e.register_ix(&owner.pubkey(), &agent.pubkey(), &owner_token);
    rejects(send(&mut e.svm, &owner, &[&agent], vec![ix]), "Paused");
    e.fund(&treasury(), 10);
    let ix = e.split_ix();
    rejects(send(&mut e.svm, &owner, &[], vec![ix]), "Paused");
    let core = e.core.insecure_clone();
    let ix = e.post_epoch_ix(&core.pubkey(), lr::PostEpochArgs { epoch: 1, payout_root: [1; 32], lineage_root: [0; 32], total_units_micro: 0,
        pool_amount: 0, rebate_amount: 0 });
    rejects(send(&mut e.svm, &core, &[], vec![ix]), "Paused");
    // Launches register through the registry, so they stop too.
    let mint = Keypair::new();
    let (launcher, _) = e.wallet(0);
    rejects(e.try_launch(&launcher, &Keypair::new(), &mint, default_launch_args()), "Paused");
    let ix = e.admin_ix(&admin.pubkey(), lr::instruction::Pause { paused: false }.data());
    ok(send(&mut e.svm, &admin, &[], vec![ix]));

    // set_config: admin only, validated, applied.
    let mut params = test_params();
    params.register_burn = 3 * ONE;
    let args = lr::ConfigArgs { admin: admin.pubkey(), core_authority: core.pubkey(), launch_program: ll::ID, params };
    let ix = e.admin_ix(&owner.pubkey(), lr::instruction::SetConfig { args }.data());
    rejects(send(&mut e.svm, &owner, &[], vec![ix]), "Unauthorized");
    let mut bad = params;
    bad.pool_bps = 2001;
    let ix = e.admin_ix(&admin.pubkey(), lr::instruction::SetConfig { args: lr::ConfigArgs { params: bad, ..args } }.data());
    rejects(send(&mut e.svm, &admin, &[], vec![ix]), "InvalidParams");
    let ix = e.admin_ix(&admin.pubkey(), lr::instruction::SetConfig { args }.data());
    ok(send(&mut e.svm, &admin, &[], vec![ix]));
    assert_eq!(e.rconfig().params, params);
    let before = balance(&e.svm, &owner_token);
    e.register_verifier(&owner, &agent);
    assert_eq!(balance(&e.svm, &owner_token), before - 3 * ONE);
    // A new Core authority takes over slashing and posting.
    let new_core = funded(&mut e.svm);
    let ix = e.admin_ix(&admin.pubkey(), lr::instruction::SetConfig { args: lr::ConfigArgs { core_authority: new_core.pubkey(), ..args } }.data());
    ok(send(&mut e.svm, &admin, &[], vec![ix]));
    let ix = e.slash_ix(&core.pubkey(), &agent.pubkey(), lr::OFFENCE_ABANDON, 1);
    rejects(send(&mut e.svm, &core, &[], vec![ix]), "Unauthorized");
    let ix = e.slash_ix(&new_core.pubkey(), &agent.pubkey(), lr::OFFENCE_ABANDON, 1);
    ok(send(&mut e.svm, &new_core, &[], vec![ix]));
}

#[test]
fn register_launched_only_through_the_launch_program() {
    let mut e = setup(LineKind::Classic);
    let impostor = funded(&mut e.svm);
    let agent = Pubkey::new_unique();
    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: lr::ID,
        accounts: anchor_lang::ToAccountMetas::to_account_metas(&lr::accounts::RegisterLaunched {
            config: registry_config(), launch_authority: impostor.pubkey(), payer: impostor.pubkey(), agent_record: agent_record(&agent),
            system_program: anchor_lang::solana_program::system_program::ID,
        }, None),
        data: lr::instruction::RegisterLaunched { args: lr::RegisterLaunchedArgs { agent, owner: impostor.pubkey(), mint: Pubkey::new_unique(), hosted: false } }.data(),
    };
    rejects(send(&mut e.svm, &impostor, &[], vec![ix]), "NotLaunchProgram");
    assert!(e.svm.get_account(&agent_record(&agent)).is_none());
}
