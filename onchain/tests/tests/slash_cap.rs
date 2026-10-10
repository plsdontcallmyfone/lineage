//! Audit A1-08: a per agent, per epoch slash cap. Before it, the Core key could slash one agent
//! again and again inside one epoch (each slash taking its share of what was left) until the bond
//! was gone. `Config.max_slash_bps_per_epoch` (admin-editable) bounds what one agent can lose to
//! slashes within one chain epoch (the window advances with each `post_epoch`); a slash past it is
//! refused whole with `SlashCap`, never clamped.
use anchor_lang::InstructionData;
use units_onchain_tests::*;

const BOND: u64 = 10_000 * ONE;

fn post(e: &mut Env, epoch: u64) -> litesvm::types::TransactionResult {
    let core = e.core.insecure_clone();
    let ix = e.post_epoch_ix(&core.pubkey(), lr::PostEpochArgs { epoch, payout_root: [epoch as u8; 32], lineage_root: [0; 32], record_root: [0; 32],
        total_units_micro: 1, pool_amount: 0, rebate_amount: 0 });
    send(&mut e.svm, &core, &[], vec![ix])
}

/// A verifier bonded with 10,000 `$LINE`.
fn bonded(e: &mut Env) -> Pubkey {
    let (owner, owner_token) = e.wallet(20_000 * ONE);
    let agent = Keypair::new();
    e.register_verifier(&owner, &agent);
    let ix = e.bond_ix(&owner.pubkey(), &agent.pubkey(), &owner_token, BOND);
    ok(send(&mut e.svm, &owner, &[], vec![ix]));
    agent.pubkey()
}

fn slash(e: &mut Env, agent: &Pubkey, offence: u8, epoch: u64, id: u64) -> litesvm::types::TransactionResult {
    let core = e.core.insecure_clone();
    let ix = e.slash_ix(&core.pubkey(), agent, offence, epoch, sid(id));
    send(&mut e.svm, &core, &[], vec![ix])
}

fn set_cap(e: &mut Env, signer: &Keypair, cap: u16) -> litesvm::types::TransactionResult {
    let ix = e.admin_ix(&signer.pubkey(), lr::instruction::SetSlashCap { max_slash_bps_per_epoch: cap }.data());
    send(&mut e.svm, signer, &[], vec![ix])
}

/// A refused slash moves nothing, strikes nothing and leaves no receipt (so Core's retry with the
/// same id can land later).
fn assert_refused_whole(e: &mut Env, agent: &Pubkey, before: &lr::Agent, reserve_before: u64, id: u64) {
    let a = e.agent(agent);
    assert_eq!((a.bond, a.slashed_total, a.strikes_total, a.strikes_in_epoch, a.slashed_in_window),
        (before.bond, before.slashed_total, before.strikes_total, before.strikes_in_epoch, before.slashed_in_window), "refused whole, not clamped");
    assert_eq!(balance(&e.svm, &reserve_vault()), reserve_before);
    assert!(e.svm.get_account(&slash_receipt(&sid(id))).is_none(), "no receipt for a refused slash");
}

/// `initialize` sets room for `strike_limit` slashes of the largest share (3 x 2,500 bps); the cap
/// counts several slashes in one epoch, and a slash that crosses it is refused, not clamped.
#[test]
fn several_slashes_in_one_epoch_stop_at_the_cap() {
    let mut e = setup(LineKind::Classic);
    assert_eq!(e.rconfig().max_slash_bps_per_epoch, 7_500, "default: strike_limit 3 x canary 2,500 bps");
    let agent = bonded(&mut e);
    // Canary 25% of what is left, four times: 2,500 + 1,875 + 1,406.25 + 1,054.6875 = 6,835.9375
    // of the 10,000 at stake; the fifth (791.015625) would make 7,626.953125 > 7,500.
    let mut slashed = 0u64;
    for (i, amount) in [(1u64, 2_500 * ONE), (2, 1_875 * ONE), (3, 1_406_250_000), (4, 1_054_687_500)] {
        ok(slash(&mut e, &agent, lr::OFFENCE_CANARY, 5, i));
        slashed += amount;
        let a = e.agent(&agent);
        assert_eq!((a.bond, a.slashed_in_window, a.slash_window), (BOND - slashed, slashed, 0));
    }
    let before = e.agent(&agent);
    let reserve = balance(&e.svm, &reserve_vault());
    rejects(slash(&mut e, &agent, lr::OFFENCE_CANARY, 5, 5), "SlashCap");
    assert_refused_whole(&mut e, &agent, &before, reserve, 5);
    // Strikes that move nothing are never refused, even with the window full.
    ok(slash(&mut e, &agent, lr::OFFENCE_ABANDON, 5, 6));
    let a = e.agent(&agent);
    assert_eq!((a.strikes_total, a.bond, a.slashed_in_window), (5, before.bond, before.slashed_in_window));
    assert_eq!(a.slashed_total + a.bond, BOND);
}

/// One slash larger than the room the cap leaves in the epoch is refused whole; a smaller one
/// that still fits lands.
#[test]
fn one_slash_past_the_room_left_is_refused() {
    let mut e = setup(LineKind::Classic);
    let admin = e.admin.insecure_clone();
    ok(set_cap(&mut e, &admin, 2_600));
    let agent = bonded(&mut e);
    // Minority 5%: 500 of the 2,600 bps x 10,000 = 2,600 allowed.
    ok(slash(&mut e, &agent, lr::OFFENCE_MINORITY, 3, 1));
    // Canary 25% of 9,500 = 2,375 alone passes the 2,100 left.
    let before = e.agent(&agent);
    let reserve = balance(&e.svm, &reserve_vault());
    rejects(slash(&mut e, &agent, lr::OFFENCE_CANARY, 3, 2), "SlashCap");
    assert_refused_whole(&mut e, &agent, &before, reserve, 2);
    // Reveal 2% of 9,500 = 190 fits (690 of 2,600).
    ok(slash(&mut e, &agent, lr::OFFENCE_REVEAL, 3, 3));
    assert_eq!(e.agent(&agent).slashed_in_window, 690 * ONE);
}

/// The cap is per chain epoch: after the next `post_epoch` the window restarts, and the refused
/// slash (same id) lands. Each agent has its own window.
#[test]
fn the_cap_resets_with_the_next_epoch_post_and_is_per_agent() {
    let mut e = setup(LineKind::Classic);
    let admin = e.admin.insecure_clone();
    ok(set_cap(&mut e, &admin, 2_500));
    let agent = bonded(&mut e);
    let other = bonded(&mut e);
    ok(post(&mut e, 0));
    ok(slash(&mut e, &agent, lr::OFFENCE_CANARY, 1, 1));
    assert_eq!((e.agent(&agent).slash_window, e.agent(&agent).slashed_in_window), (1, 2_500 * ONE));
    rejects(slash(&mut e, &agent, lr::OFFENCE_REVEAL, 1, 2), "SlashCap");
    // another agent in the same epoch is not affected
    ok(slash(&mut e, &other, lr::OFFENCE_CANARY, 1, 3));
    // the next epoch posts (clocked: one epoch length later)
    warp(&mut e.svm, test_params().epoch_length_s as i64);
    ok(post(&mut e, 1));
    // Core's retry of the refused slash, same id, lands in the new window: 2% of 7,500 = 150.
    ok(slash(&mut e, &agent, lr::OFFENCE_REVEAL, 1, 2));
    let a = e.agent(&agent);
    assert_eq!((a.slash_window, a.slashed_in_window, a.bond), (2, 150 * ONE, 7_350 * ONE));
    assert!(e.svm.get_account(&slash_receipt(&sid(2))).is_some());
    // and the new window has its own cap: 25% of 7,500 at stake = 1,875; 150 + 25% of 7,350 = 1,987.5 passes it
    rejects(slash(&mut e, &agent, lr::OFFENCE_CANARY, 2, 4), "SlashCap");
}

/// Only the admin edits the cap; it may not sit below a single slash share or above 10,000 bps,
/// and `set_config` may not raise a share above it. 10,000 lifts the cap.
#[test]
fn the_admin_edits_the_cap_and_nobody_else() {
    let mut e = setup(LineKind::Classic);
    let admin = e.admin.insecure_clone();
    let core = e.core.insecure_clone();
    let stranger = funded(&mut e.svm);
    rejects(set_cap(&mut e, &stranger, 10_000), "Unauthorized");
    rejects(set_cap(&mut e, &core, 10_000), "Unauthorized");
    assert_eq!(e.rconfig().max_slash_bps_per_epoch, 7_500);
    rejects(set_cap(&mut e, &admin, 2_499), "SlashCapBelowShare");
    rejects(set_cap(&mut e, &admin, 10_001), "InvalidParams");
    ok(set_cap(&mut e, &admin, 2_500));
    assert_eq!(e.rconfig().max_slash_bps_per_epoch, 2_500);
    // set_config cannot raise the canary share above the cap; it can after the cap is raised
    let args = lr::ConfigArgs { params: lr::Params { canary_slash_bps: 5_000, ..test_params() }, ..config_args(&admin.pubkey(), &core.pubkey()) };
    let ix = e.admin_ix(&admin.pubkey(), lr::instruction::SetConfig { args }.data());
    rejects(send(&mut e.svm, &admin, &[], vec![ix.clone()]), "SlashCapBelowShare");
    ok(set_cap(&mut e, &admin, 10_000));
    ok(send(&mut e.svm, &admin, &[], vec![ix]));
    assert_eq!((e.rconfig().params.canary_slash_bps, e.rconfig().max_slash_bps_per_epoch), (5_000, 10_000));
    // 10,000 lets the whole bond go in one epoch, as before the cap
    let agent = bonded(&mut e);
    for i in 1..=6 {
        ok(slash(&mut e, &agent, lr::OFFENCE_CANARY, 1, i));
    }
    assert_eq!(e.agent(&agent).bond, BOND / 64);
}

/// The devnet Config predates the cap: `migrate_config_slash_cap` grows it by two bytes, admin
/// only, once, with a checked cap. Agent records need no migration (the window fields were carved
/// from the zeroed v2 reserve).
#[test]
fn migrate_config_slash_cap_grows_the_previous_layout() {
    let mut e = setup(LineKind::Classic);
    let admin = e.admin.insecure_clone();
    let agent = bonded(&mut e);
    ok(post(&mut e, 0));
    let key = registry_config();
    let mut acct = e.svm.get_account(&key).unwrap();
    let full = acct.data.clone();
    acct.data.truncate(full.len() - lr::CONFIG_V2_TAIL);
    acct.lamports = e.svm.minimum_balance_for_rent_exemption(acct.data.len());
    e.svm.set_account(key, acct).unwrap();
    // the previous layout does not deserialize: slashes and posts fail until the migration
    rejects(slash(&mut e, &agent, lr::OFFENCE_CANARY, 1, 1), "AccountDidNotDeserialize");
    let ix = |signer: Pubkey, cap: u16| anchor_lang::solana_program::instruction::Instruction {
        program_id: lr::ID,
        accounts: anchor_lang::ToAccountMetas::to_account_metas(&lr::accounts::MigrateConfig { config: key, admin: signer,
            system_program: anchor_lang::solana_program::system_program::ID }, None),
        data: lr::instruction::MigrateConfigSlashCap { max_slash_bps_per_epoch: cap }.data(),
    };
    let stranger = funded(&mut e.svm);
    rejects(send(&mut e.svm, &stranger, &[], vec![ix(stranger.pubkey(), 2_500)]), "Unauthorized");
    rejects(send(&mut e.svm, &admin, &[], vec![ix(admin.pubkey(), 2_000)]), "SlashCapBelowShare");
    // the v1 migration refuses this layout
    let v1 = anchor_lang::solana_program::instruction::Instruction {
        program_id: lr::ID,
        accounts: anchor_lang::ToAccountMetas::to_account_metas(&lr::accounts::MigrateConfig { config: key, admin: admin.pubkey(),
            system_program: anchor_lang::solana_program::system_program::ID }, None),
        data: lr::instruction::MigrateConfig { max_rebate_per_epoch: 1 }.data(),
    };
    rejects(send(&mut e.svm, &admin, &[], vec![v1]), "InvalidParams");
    ok(send(&mut e.svm, &admin, &[], vec![ix(admin.pubkey(), 2_500)]));
    let c = e.rconfig();
    assert_eq!((c.max_slash_bps_per_epoch, c.epochs_posted, c.max_rebate_per_epoch), (2_500, 1, MAX_REBATE));
    assert_eq!(c.params, test_params());
    let mut want = full.clone();
    let n = want.len();
    want[n - 2..].copy_from_slice(&2_500u16.to_le_bytes());
    assert_eq!(e.svm.get_account(&key).unwrap().data, want, "only the cap bytes were added");
    rejects(send(&mut e.svm, &admin, &[], vec![ix(admin.pubkey(), 2_500)]), "InvalidParams");
    // the cap applies at once
    ok(slash(&mut e, &agent, lr::OFFENCE_CANARY, 1, 1));
    rejects(slash(&mut e, &agent, lr::OFFENCE_REVEAL, 1, 2), "SlashCap");
    ok(post(&mut e, 1));
}
