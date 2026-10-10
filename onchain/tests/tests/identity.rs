//! Agent v2 (identity plan I1): key rotation needs the owner and the new key, revocation by the
//! owner, profile digests by the current signing key, the two-step public owner transfer, and
//! `migrate_agent` / `migrate_epoch` growing accounts the earlier layouts wrote.
use anchor_lang::solana_program::instruction::AccountMeta;
use anchor_lang::InstructionData;
use units_onchain_tests::*;

fn verifier(e: &mut Env) -> (Keypair, Pubkey, Keypair) {
    let (owner, owner_token) = e.wallet(20_000 * ONE);
    let agent = Keypair::new();
    e.register_verifier(&owner, &agent);
    (owner, owner_token, agent)
}

#[test]
fn new_records_start_as_v2_with_the_agent_key() {
    let mut e = setup(LineKind::PumpCoin);
    let (owner, _, agent) = verifier(&mut e);
    let a = e.agent(&agent.pubkey());
    assert_eq!((a.signing_key, a.key_seq, a.key_changed_at, a.profile_seq, a.pending_owner, a.owner_since), (agent.pubkey(), 0, 0, 0, Pubkey::default(), NOW));
    assert_eq!(a.owner, owner.pubkey());
    assert_eq!(e.svm.get_account(&agent_record(&agent.pubkey())).unwrap().data.len(), 8 + <lr::Agent as anchor_lang::Space>::INIT_SPACE);
    // Launched agents too (register_launched through units_launch).
    let l = e.launch_agent(Keypair::new(), default_launch_args());
    let a = e.agent(&l.agent.pubkey());
    assert_eq!((a.signing_key, a.owner, a.owner_since), (l.agent.pubkey(), l.launcher.pubkey(), NOW));
}

#[test]
fn rotate_needs_the_owner_and_the_new_key() {
    let mut e = setup(LineKind::Classic);
    let (owner, _, agent) = verifier(&mut e);
    let new_key = Keypair::new();
    // The new key must sign: the same instruction with it marked non-signer is refused.
    let mut ix = e.rotate_agent_key_ix(&owner.pubkey(), &agent.pubkey(), &new_key.pubkey());
    ix.accounts[2] = AccountMeta::new_readonly(new_key.pubkey(), false);
    rejects(send(&mut e.svm, &owner, &[], vec![ix]), "AccountNotSigner");
    // The owner must sign: the agent key or a stranger in the owner slot is refused.
    let stranger = funded(&mut e.svm);
    let ix = e.rotate_agent_key_ix(&stranger.pubkey(), &agent.pubkey(), &new_key.pubkey());
    rejects(send(&mut e.svm, &stranger, &[&new_key], vec![ix]), "Unauthorized");
    let ix = e.rotate_agent_key_ix(&agent.pubkey(), &agent.pubkey(), &new_key.pubkey());
    e.svm.airdrop(&agent.pubkey(), 1_000_000_000).unwrap();
    rejects(send(&mut e.svm, &agent, &[&new_key], vec![ix]), "Unauthorized");
    // Owner plus new key: rotated.
    warp(&mut e.svm, 10);
    let ix = e.rotate_agent_key_ix(&owner.pubkey(), &agent.pubkey(), &new_key.pubkey());
    ok(send(&mut e.svm, &owner, &[&new_key], vec![ix]));
    let a = e.agent(&agent.pubkey());
    assert_eq!((a.agent, a.signing_key, a.key_seq, a.key_changed_at), (agent.pubkey(), new_key.pubkey(), 1, NOW + 10));
    // Paused: refused.
    let admin = e.admin.insecure_clone();
    let ix = e.admin_ix(&admin.pubkey(), lr::instruction::Pause { paused: true }.data());
    ok(send(&mut e.svm, &admin, &[], vec![ix]));
    let k2 = Keypair::new();
    let ix = e.rotate_agent_key_ix(&owner.pubkey(), &agent.pubkey(), &k2.pubkey());
    rejects(send(&mut e.svm, &owner, &[&k2], vec![ix]), "Paused");
}

#[test]
fn revoke_blocks_until_a_rotation() {
    let mut e = setup(LineKind::Classic);
    let (owner, _, agent) = verifier(&mut e);
    let stranger = funded(&mut e.svm);
    let ix = e.owner_agent_ix(&stranger.pubkey(), &agent.pubkey(), lr::instruction::RevokeAgentKey {}.data());
    rejects(send(&mut e.svm, &stranger, &[], vec![ix]), "Unauthorized");
    // The agent key cannot revoke itself either: only the owner.
    e.svm.airdrop(&agent.pubkey(), 1_000_000_000).unwrap();
    let ix = e.owner_agent_ix(&agent.pubkey(), &agent.pubkey(), lr::instruction::RevokeAgentKey {}.data());
    rejects(send(&mut e.svm, &agent, &[], vec![ix]), "Unauthorized");
    // Revocation works even while paused (it only removes power).
    let admin = e.admin.insecure_clone();
    let ix = e.admin_ix(&admin.pubkey(), lr::instruction::Pause { paused: true }.data());
    ok(send(&mut e.svm, &admin, &[], vec![ix]));
    let ix = e.owner_agent_ix(&owner.pubkey(), &agent.pubkey(), lr::instruction::RevokeAgentKey {}.data());
    ok(send(&mut e.svm, &owner, &[], vec![ix]));
    let ix = e.admin_ix(&admin.pubkey(), lr::instruction::Pause { paused: false }.data());
    ok(send(&mut e.svm, &admin, &[], vec![ix]));
    let a = e.agent(&agent.pubkey());
    assert_eq!((a.signing_key, a.key_seq), (Pubkey::default(), 1));
    // A revoked key cannot speak for the agent (set_profile is the onchain action it signs).
    let ix = e.set_profile_ix(&agent.pubkey(), &agent.pubkey(), [1; 32], 1);
    rejects(send(&mut e.svm, &agent, &[], vec![ix]), "KeyRevoked");
    // Rotate back to the original key restores it.
    let ix = e.rotate_agent_key_ix(&owner.pubkey(), &agent.pubkey(), &agent.pubkey());
    ok(send(&mut e.svm, &owner, &[&agent], vec![ix]));
    let a = e.agent(&agent.pubkey());
    assert_eq!((a.signing_key, a.key_seq), (agent.pubkey(), 2));
    let ix = e.set_profile_ix(&agent.pubkey(), &agent.pubkey(), [1; 32], 1);
    ok(send(&mut e.svm, &agent, &[], vec![ix]));
}

#[test]
fn profile_is_set_by_the_current_signing_key_with_increasing_seq() {
    let mut e = setup(LineKind::Classic);
    let (owner, _, agent) = verifier(&mut e);
    let new_key = Keypair::new();
    e.svm.airdrop(&new_key.pubkey(), 1_000_000_000).unwrap();
    e.svm.airdrop(&agent.pubkey(), 1_000_000_000).unwrap();
    let ix = e.rotate_agent_key_ix(&owner.pubkey(), &agent.pubkey(), &new_key.pubkey());
    ok(send(&mut e.svm, &owner, &[&new_key], vec![ix]));
    // The old key and the owner are refused; the agent, not the owner, speaks for its profile.
    let ix = e.set_profile_ix(&agent.pubkey(), &agent.pubkey(), [1; 32], 1);
    rejects(send(&mut e.svm, &agent, &[], vec![ix]), "Unauthorized");
    let ix = e.set_profile_ix(&owner.pubkey(), &agent.pubkey(), [1; 32], 1);
    rejects(send(&mut e.svm, &owner, &[], vec![ix]), "Unauthorized");
    let ix = e.set_profile_ix(&new_key.pubkey(), &agent.pubkey(), [1; 32], 1);
    ok(send(&mut e.svm, &new_key, &[], vec![ix]));
    let ix = e.set_profile_ix(&new_key.pubkey(), &agent.pubkey(), [2; 32], 1);
    rejects(send(&mut e.svm, &new_key, &[], vec![ix]), "ProfileSeq");
    let ix = e.set_profile_ix(&new_key.pubkey(), &agent.pubkey(), [2; 32], 5);
    ok(send(&mut e.svm, &new_key, &[], vec![ix]));
    let a = e.agent(&agent.pubkey());
    assert_eq!((a.profile_digest, a.profile_seq), ([2; 32], 5));
}

#[test]
fn owner_transfer_is_two_step_and_public() {
    let mut e = setup(LineKind::Classic);
    let (owner, owner_token, agent) = verifier(&mut e);
    let ix = e.bond_ix(&owner.pubkey(), &agent.pubkey(), &owner_token, 6_000 * ONE);
    ok(send(&mut e.svm, &owner, &[], vec![ix]));
    let (new_owner, new_token) = e.wallet(0);
    let (mallory, _) = e.wallet(0);
    // Only the owner proposes; proposing yourself is refused.
    let ix = e.owner_agent_ix(&mallory.pubkey(), &agent.pubkey(), lr::instruction::ProposeOwner { new_owner: mallory.pubkey() }.data());
    rejects(send(&mut e.svm, &mallory, &[], vec![ix]), "Unauthorized");
    let ix = e.owner_agent_ix(&owner.pubkey(), &agent.pubkey(), lr::instruction::ProposeOwner { new_owner: owner.pubkey() }.data());
    rejects(send(&mut e.svm, &owner, &[], vec![ix]), "InvalidParams");
    // Nothing pending: accept refused.
    let ix = e.accept_owner_ix(&new_owner.pubkey(), &agent.pubkey());
    rejects(send(&mut e.svm, &new_owner, &[], vec![ix]), "NoPendingOwner");
    let ix = e.owner_agent_ix(&owner.pubkey(), &agent.pubkey(), lr::instruction::ProposeOwner { new_owner: new_owner.pubkey() }.data());
    ok(send(&mut e.svm, &owner, &[], vec![ix]));
    assert_eq!(e.agent(&agent.pubkey()).pending_owner, new_owner.pubkey());
    // Proposing changes nothing yet: the old owner still controls the agent.
    assert_eq!(e.agent(&agent.pubkey()).owner, owner.pubkey());
    // Someone else cannot accept.
    let ix = e.accept_owner_ix(&mallory.pubkey(), &agent.pubkey());
    rejects(send(&mut e.svm, &mallory, &[], vec![ix]), "Unauthorized");
    // Cancel, then propose again.
    let ix = e.owner_agent_ix(&owner.pubkey(), &agent.pubkey(), lr::instruction::ProposeOwner { new_owner: Pubkey::default() }.data());
    ok(send(&mut e.svm, &owner, &[], vec![ix]));
    let ix = e.accept_owner_ix(&new_owner.pubkey(), &agent.pubkey());
    rejects(send(&mut e.svm, &new_owner, &[], vec![ix]), "NoPendingOwner");
    let ix = e.owner_agent_ix(&owner.pubkey(), &agent.pubkey(), lr::instruction::ProposeOwner { new_owner: new_owner.pubkey() }.data());
    ok(send(&mut e.svm, &owner, &[], vec![ix]));
    warp(&mut e.svm, 100);
    let ix = e.accept_owner_ix(&new_owner.pubkey(), &agent.pubkey());
    ok(send(&mut e.svm, &new_owner, &[], vec![ix]));
    let a = e.agent(&agent.pubkey());
    assert_eq!((a.owner, a.pending_owner, a.owner_since, a.signing_key, a.bond), (new_owner.pubkey(), Pubkey::default(), NOW + 100, agent.pubkey(),
        6_000 * ONE));
    // The old owner lost control; the new owner unbonds and withdraws to its own account.
    let ix = e.owner_agent_ix(&owner.pubkey(), &agent.pubkey(), lr::instruction::RequestUnbond { amount: ONE }.data());
    rejects(send(&mut e.svm, &owner, &[], vec![ix]), "Unauthorized");
    let k = Keypair::new();
    let ix = e.rotate_agent_key_ix(&owner.pubkey(), &agent.pubkey(), &k.pubkey());
    rejects(send(&mut e.svm, &owner, &[&k], vec![ix]), "Unauthorized");
    let ix = e.owner_agent_ix(&new_owner.pubkey(), &agent.pubkey(), lr::instruction::RequestUnbond { amount: ONE }.data());
    ok(send(&mut e.svm, &new_owner, &[], vec![ix]));
    warp(&mut e.svm, 600);
    let ix = e.withdraw_unbonded_ix(&new_owner.pubkey(), &agent.pubkey(), &new_token);
    ok(send(&mut e.svm, &new_owner, &[], vec![ix]));
    assert_eq!(balance(&e.svm, &new_token), ONE);
    // The new owner rotates the key the old controller's runtime held.
    let ix = e.rotate_agent_key_ix(&new_owner.pubkey(), &agent.pubkey(), &k.pubkey());
    ok(send(&mut e.svm, &new_owner, &[&k], vec![ix]));
}

/// The devnet Agent records were written by the first layout; `migrate_agent` grows them.
#[test]
fn migrate_agent_grows_v1_records() {
    let mut e = setup(LineKind::Classic);
    let (owner, owner_token, agent) = verifier(&mut e);
    let key = agent_record(&agent.pubkey());
    let mut acct = e.svm.get_account(&key).unwrap();
    let full = acct.data.clone();
    acct.data.truncate(full.len() - lr::AGENT_V1_TAIL);
    acct.lamports = e.svm.minimum_balance_for_rent_exemption(acct.data.len());
    e.svm.set_account(key, acct).unwrap();
    // A v1 record does not deserialize: bond (and every other Agent instruction) fails until migrated.
    let ix = e.bond_ix(&owner.pubkey(), &agent.pubkey(), &owner_token, ONE);
    rejects(send(&mut e.svm, &owner, &[], vec![ix]), "AccountDidNotDeserialize");
    // Anyone may migrate (and pays the added rent).
    let payer = funded(&mut e.svm);
    let before = e.svm.get_balance(&payer.pubkey()).unwrap();
    ok(send(&mut e.svm, &payer, &[], vec![migrate_agent_ix(&payer.pubkey(), &agent.pubkey())]));
    assert!(e.svm.get_balance(&payer.pubkey()).unwrap() < before);
    let a = e.agent(&agent.pubkey());
    assert_eq!((a.signing_key, a.key_seq, a.owner_since, a.pending_owner, a.owner), (agent.pubkey(), 0, NOW, Pubkey::default(), owner.pubkey()));
    assert_eq!(e.svm.get_account(&key).unwrap().data.len(), full.len());
    assert_eq!(e.svm.get_account(&key).unwrap().data[..full.len() - lr::AGENT_V1_TAIL], full[..full.len() - lr::AGENT_V1_TAIL]);
    // Once only.
    rejects(send(&mut e.svm, &payer, &[], vec![migrate_agent_ix(&payer.pubkey(), &agent.pubkey())]), "InvalidParams");
    let ix = e.bond_ix(&owner.pubkey(), &agent.pubkey(), &owner_token, ONE);
    ok(send(&mut e.svm, &owner, &[], vec![ix]));
    // Not an Agent: the Config (another discriminator) is refused.
    let ix = anchor_lang::solana_program::instruction::Instruction {
        program_id: lr::ID,
        accounts: anchor_lang::ToAccountMetas::to_account_metas(&lr::accounts::MigrateAgent { agent_record: registry_config(), payer: payer.pubkey(),
            system_program: anchor_lang::solana_program::system_program::ID }, None),
        data: lr::instruction::MigrateAgent {}.data(),
    };
    rejects(send(&mut e.svm, &payer, &[], vec![ix]), "InvalidParams");
}

/// Epochs posted before `record_root` existed keep their claims through `migrate_epoch`.
#[test]
fn migrate_epoch_keeps_old_epochs_claimable() {
    let mut e = setup(LineKind::Classic);
    let (owner, owner_token, agent) = verifier(&mut e);
    let leaf = lr::leaf::payout_leaf(1, &agent.pubkey().to_bytes(), lr::leaf::Dest::AgentWallet, &[0; 32], 5_000);
    e.fund(&reserve_vault(), 5_000);
    let core = e.core.insecure_clone();
    let ix = e.post_epoch_ix(&core.pubkey(), lr::PostEpochArgs { epoch: 1, payout_root: leaf, lineage_root: [0; 32], record_root: [9; 32],
        total_units_micro: 1, pool_amount: 0, rebate_amount: 5_000 });
    ok(send(&mut e.svm, &core, &[], vec![ix]));
    let key = epoch_pda(1);
    let mut acct = e.svm.get_account(&key).unwrap();
    let full = acct.data.len();
    acct.data.truncate(full - lr::EPOCH_V1_TAIL);
    acct.lamports = e.svm.minimum_balance_for_rent_exemption(acct.data.len());
    e.svm.set_account(key, acct).unwrap();
    let args = lr::ClaimArgs { agent: agent.pubkey(), dest_kind: 0, wallet: Pubkey::default(), amount: 5_000, leaf, proof: vec![] };
    let ix = e.claim_ix(&owner.pubkey(), 1, args.clone(), Some(agent_record(&agent.pubkey())), &owner_token);
    assert!(send(&mut e.svm, &owner, &[], vec![ix]).is_err());
    let payer = funded(&mut e.svm);
    ok(send(&mut e.svm, &payer, &[], vec![migrate_epoch_ix(&payer.pubkey(), 1)]));
    let ep: lr::Epoch = read(&e.svm, &key);
    assert_eq!((ep.epoch, ep.payout_root, ep.record_root), (1, leaf, [0; 32]));
    rejects(send(&mut e.svm, &payer, &[], vec![migrate_epoch_ix(&payer.pubkey(), 1)]), "InvalidParams");
    let ix = e.claim_ix(&owner.pubkey(), 1, args, Some(agent_record(&agent.pubkey())), &owner_token);
    ok(send(&mut e.svm, &owner, &[], vec![ix]));
}
