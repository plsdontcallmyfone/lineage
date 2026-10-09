//! Bonded challenges (SPEC 10.8, challenge.rs) on LiteSVM: the admin config and its bond vault,
//! payouts held for the window and while a challenge is open, an upheld epoch challenge correcting
//! the root before any claim, an upheld slash challenge reversing the slash exactly once, a failed
//! challenge forfeiting its bond to the reserve, expiry, and the attacks: unregistered or wrong
//! signer, revoked key, late challenges, forged subjects, a stranger resolving, a refund redirected,
//! a correction smuggled into a slash or a failed resolution, double resolution.
use anchor_lang::InstructionData;
use lineage_onchain_tests::*;

const WINDOW: i64 = 600;
const BOND: u64 = 2 * ONE;
const REWARD: u64 = ONE;
const TIMEOUT: i64 = 3_600;

fn cfg_args() -> lr::ChallengeConfigArgs {
    lr::ChallengeConfigArgs { window_s: WINDOW, bond: BOND, reward: REWARD, resolve_timeout_s: TIMEOUT, paused: false }
}

fn configured() -> Env {
    let mut e = setup(LineKind::Classic);
    let admin = e.admin.insecure_clone();
    let ix = e.set_challenge_config_ix(&admin.pubkey(), cfg_args());
    ok(send(&mut e.svm, &admin, &[], vec![ix]));
    e
}

/// A registered verifier (agent key = signing key) whose owner holds `$LINE` for bonds.
struct Challenger {
    owner: Keypair,
    owner_token: Pubkey,
    agent: Keypair,
}
fn challenger(e: &mut Env) -> Challenger {
    let (owner, owner_token) = e.wallet(1_100 * ONE);
    let agent = Keypair::new();
    e.register_verifier(&owner, &agent);
    Challenger { owner, owner_token, agent }
}

fn open(e: &mut Env, c: &Challenger, args: lr::OpenChallengeArgs) -> litesvm::types::TransactionResult {
    let ix = e.open_challenge_ix(&c.agent.pubkey(), &c.agent.pubkey(), &c.owner.pubkey(), &c.owner_token, args);
    send(&mut e.svm, &c.owner, &[&c.agent], vec![ix])
}

fn post_one_leaf(e: &mut Env, epoch: u64, root: [u8; 32], amount: u64) {
    e.fund(&reserve_vault(), amount);
    let core = e.core.insecure_clone();
    let args = lr::PostEpochArgs { epoch, payout_root: root, lineage_root: [1; 32], record_root: [2; 32], total_units_micro: 1, pool_amount: 0,
        rebate_amount: amount };
    let ix = e.post_epoch_ix(&core.pubkey(), args);
    ok(send(&mut e.svm, &core, &[], vec![ix]));
}

fn wallet_leaf(epoch: u64, wallet: &Pubkey, amount: u64) -> [u8; 32] {
    lr::leaf::payout_leaf(epoch, &[0; 32], lr::leaf::Dest::Wallet, &wallet.to_bytes(), amount)
}
fn wallet_claim(e: &Env, payer: &Pubkey, epoch: u64, wallet: &Pubkey, wallet_token: &Pubkey, amount: u64) -> anchor_lang::solana_program::instruction::Instruction {
    let leaf = wallet_leaf(epoch, wallet, amount);
    let args = lr::ClaimArgs { agent: Pubkey::default(), dest_kind: 2, wallet: *wallet, amount, leaf, proof: vec![] };
    e.claim_ix(payer, epoch, args, None, wallet_token)
}

fn resolve_args(outcome: u8, corrected: Option<lr::CorrectedRoots>) -> lr::ResolveChallengeArgs {
    lr::ResolveChallengeArgs { outcome, evidence: [0xee; 32], corrected }
}

#[test]
fn config_is_admin_only_and_claims_wait_for_the_window() {
    let mut e = setup(LineKind::Classic);
    let (w, w_token) = e.wallet(0);
    // Before any ChallengeConfig exists claims are not held (existing deployments keep working).
    post_one_leaf(&mut e, 1, wallet_leaf(1, &w.pubkey(), 500), 500);
    let ix = wallet_claim(&e, &w.pubkey(), 1, &w.pubkey(), &w_token, 500);
    ok(send(&mut e.svm, &w, &[], vec![ix]));

    let stranger = funded(&mut e.svm);
    let ix = e.set_challenge_config_ix(&stranger.pubkey(), cfg_args());
    rejects(send(&mut e.svm, &stranger, &[], vec![ix]), "Unauthorized");
    let admin = e.admin.insecure_clone();
    let ix = e.set_challenge_config_ix(&admin.pubkey(), lr::ChallengeConfigArgs { window_s: 0, ..cfg_args() });
    rejects(send(&mut e.svm, &admin, &[], vec![ix]), "InvalidParams");
    let ix = e.set_challenge_config_ix(&admin.pubkey(), cfg_args());
    ok(send(&mut e.svm, &admin, &[], vec![ix]));
    let cc: lr::ChallengeConfig = read(&e.svm, &challenge_config());
    assert_eq!((cc.window_s, cc.bond, cc.reward, cc.resolve_timeout_s, cc.paused, cc.open), (WINDOW, BOND, REWARD, TIMEOUT, false, 0));
    assert_eq!(balance(&e.svm, &challenge_vault()), 0);
    // Updating keeps the same accounts (init_if_needed).
    let ix = e.set_challenge_config_ix(&admin.pubkey(), cfg_args());
    ok(send(&mut e.svm, &admin, &[], vec![ix]));

    // Epoch 2: held for WINDOW seconds after its post, paid after.
    post_one_leaf(&mut e, 2, wallet_leaf(2, &w.pubkey(), 700), 700);
    let ix = wallet_claim(&e, &w.pubkey(), 2, &w.pubkey(), &w_token, 700);
    rejects(send(&mut e.svm, &w, &[], vec![ix.clone()]), "ClaimHeld");
    warp(&mut e.svm, WINDOW - 1);
    rejects(send(&mut e.svm, &w, &[], vec![ix.clone()]), "ClaimHeld");
    warp(&mut e.svm, 1);
    ok(send(&mut e.svm, &w, &[], vec![ix]));
    assert_eq!(balance(&e.svm, &w_token), 1_200);
}

#[test]
fn upheld_epoch_challenge_corrects_the_root_before_any_claim() {
    let mut e = configured();
    let c = challenger(&mut e);
    let (w, w_token) = e.wallet(0);
    let (thief, thief_token) = e.wallet(0);
    // Core posts a root paying a thief; the honest root pays w.
    let wrong = wallet_leaf(3, &thief.pubkey(), 900);
    let right = wallet_leaf(3, &w.pubkey(), 900);
    post_one_leaf(&mut e, 3, wrong, 900);
    let subject = lr::epoch_subject(3);
    // An epoch challenge's subject is its epoch number.
    rejects(open(&mut e, &c, lr::OpenChallengeArgs { kind: lr::KIND_EPOCH, subject: [9; 32], epoch: 3, claim: [1; 32] }), "ChallengeSubject");
    e.fund(&reserve_vault(), 10 * ONE); // the reward comes from the reserve
    let reserve0 = balance(&e.svm, &reserve_vault());
    let tok0 = balance(&e.svm, &c.owner_token);
    ok(open(&mut e, &c, lr::OpenChallengeArgs { kind: lr::KIND_EPOCH, subject, epoch: 3, claim: [1; 32] }));
    assert_eq!(balance(&e.svm, &c.owner_token), tok0 - BOND);
    assert_eq!(balance(&e.svm, &challenge_vault()), BOND);
    let ch: lr::Challenge = read(&e.svm, &challenge_pda(lr::KIND_EPOCH, &subject));
    assert_eq!((ch.kind, ch.epoch, ch.challenger, ch.bond, ch.status, ch.refund_token), (lr::KIND_EPOCH, 3, c.agent.pubkey(), BOND, lr::CH_OPEN,
        c.owner_token));
    let g: lr::ChallengeGate = read(&e.svm, &challenge_gate(3));
    assert_eq!((g.epoch, g.open), (3, 1));
    // One challenge per subject.
    let c2 = challenger(&mut e);
    rejects(open(&mut e, &c2, lr::OpenChallengeArgs { kind: lr::KIND_EPOCH, subject, epoch: 3, claim: [2; 32] }), "already in use");

    // The window passes but the open challenge keeps the epoch held.
    warp(&mut e.svm, WINDOW + 10);
    let ix = wallet_claim(&e, &thief.pubkey(), 3, &thief.pubkey(), &thief_token, 900);
    rejects(send(&mut e.svm, &thief, &[], vec![ix]), "ClaimHeld");

    let core = e.core.insecure_clone();
    let roots = lr::CorrectedRoots { payout_root: right, lineage_root: [3; 32], record_root: [4; 32], total_units_micro: 2 };
    // Only the Core authority resolves.
    let ix = e.resolve_challenge_ix(&thief.pubkey(), lr::KIND_EPOCH, &subject, 3, &c.owner_token, resolve_args(lr::CH_UPHELD, Some(roots)), None);
    rejects(send(&mut e.svm, &thief, &[], vec![ix]), "Unauthorized");
    // The bond goes back only to the token account the challenge recorded.
    let ix = e.resolve_challenge_ix(&core.pubkey(), lr::KIND_EPOCH, &subject, 3, &thief_token, resolve_args(lr::CH_UPHELD, Some(roots)), None);
    rejects(send(&mut e.svm, &core, &[], vec![ix]), "BadDestination");
    // A correction rides only on an upheld resolution.
    let ix = e.resolve_challenge_ix(&core.pubkey(), lr::KIND_EPOCH, &subject, 3, &c.owner_token, resolve_args(lr::CH_FAILED, Some(roots)), None);
    rejects(send(&mut e.svm, &core, &[], vec![ix]), "ChallengeOutcome");
    let ix = e.resolve_challenge_ix(&core.pubkey(), lr::KIND_EPOCH, &subject, 3, &c.owner_token, resolve_args(9, None), None);
    rejects(send(&mut e.svm, &core, &[], vec![ix]), "ChallengeOutcome");
    let ix = e.resolve_challenge_ix(&core.pubkey(), lr::KIND_EPOCH, &subject, 3, &c.owner_token, resolve_args(lr::CH_UPHELD, Some(roots)), None);
    ok(send(&mut e.svm, &core, &[], vec![ix.clone()]));
    // Bond back plus the reward from the reserve.
    assert_eq!(balance(&e.svm, &c.owner_token), tok0 + REWARD);
    assert_eq!(balance(&e.svm, &reserve_vault()), reserve0 - REWARD);
    assert_eq!(balance(&e.svm, &challenge_vault()), 0);
    let ep: lr::Epoch = read(&e.svm, &epoch_pda(3));
    assert_eq!((ep.payout_root, ep.lineage_root, ep.record_root, ep.total_units_micro), (right, [3; 32], [4; 32], 2));
    let ch: lr::Challenge = read(&e.svm, &challenge_pda(lr::KIND_EPOCH, &subject));
    assert_eq!((ch.status, ch.reward, ch.corrected, ch.evidence), (lr::CH_UPHELD, REWARD, true, [0xee; 32]));
    let g: lr::ChallengeGate = read(&e.svm, &challenge_gate(3));
    assert_eq!((g.open, g.upheld, g.corrected), (0, 1, true));
    let cc: lr::ChallengeConfig = read(&e.svm, &challenge_config());
    assert_eq!(cc.open, 0);
    // Resolved once.
    rejects(send(&mut e.svm, &core, &[], vec![ix]), "ChallengeNotOpen");
    // The wrong leaf no longer verifies; the corrected one pays.
    let ix = wallet_claim(&e, &thief.pubkey(), 3, &thief.pubkey(), &thief_token, 900);
    rejects(send(&mut e.svm, &thief, &[], vec![ix]), "BadProof");
    let ix = wallet_claim(&e, &w.pubkey(), 3, &w.pubkey(), &w_token, 900);
    ok(send(&mut e.svm, &w, &[], vec![ix]));
    assert_eq!(balance(&e.svm, &w_token), 900);
    // Too late now.
    let c3 = challenger(&mut e);
    rejects(open(&mut e, &c3, lr::OpenChallengeArgs { kind: lr::KIND_VERDICT, subject: [7; 32], epoch: 3, claim: [0; 32] }), "ChallengeWindow");
}

#[test]
fn verdict_challenges_on_the_open_epoch_and_a_failed_one_forfeits_the_bond() {
    let mut e = configured();
    let c = challenger(&mut e);
    post_one_leaf(&mut e, 5, [0; 32], 0);
    // An unposted epoch: only the next one (6) can hold a verdict, and only verdicts may name it.
    rejects(open(&mut e, &c, lr::OpenChallengeArgs { kind: lr::KIND_VERDICT, subject: [1; 32], epoch: 7, claim: [0; 32] }), "ChallengeEpoch");
    rejects(open(&mut e, &c, lr::OpenChallengeArgs { kind: lr::KIND_EPOCH, subject: lr::epoch_subject(6), epoch: 6, claim: [0; 32] }),
        "ChallengeEpoch");
    let reserve0 = balance(&e.svm, &reserve_vault());
    let tok0 = balance(&e.svm, &c.owner_token);
    ok(open(&mut e, &c, lr::OpenChallengeArgs { kind: lr::KIND_VERDICT, subject: [1; 32], epoch: 6, claim: [0; 32] }));
    // Core posts epoch 6 while the challenge is open: its claims wait for the resolution.
    let (w, w_token) = e.wallet(0);
    post_one_leaf(&mut e, 6, wallet_leaf(6, &w.pubkey(), 300), 300);
    let reserve1 = balance(&e.svm, &reserve_vault());
    warp(&mut e.svm, WINDOW);
    let ix = wallet_claim(&e, &w.pubkey(), 6, &w.pubkey(), &w_token, 300);
    rejects(send(&mut e.svm, &w, &[], vec![ix.clone()]), "ClaimHeld");
    let core = e.core.insecure_clone();
    let ix_r = e.resolve_challenge_ix(&core.pubkey(), lr::KIND_VERDICT, &[1; 32], 6, &c.owner_token, resolve_args(lr::CH_FAILED, None), None);
    ok(send(&mut e.svm, &core, &[], vec![ix_r]));
    // The bond went to the reserve; nothing came back.
    assert_eq!(balance(&e.svm, &c.owner_token), tok0 - BOND);
    assert_eq!(balance(&e.svm, &reserve_vault()), reserve1 + BOND);
    assert!(reserve1 >= reserve0);
    let ch: lr::Challenge = read(&e.svm, &challenge_pda(lr::KIND_VERDICT, &[1; 32]));
    assert_eq!((ch.status, ch.reward), (lr::CH_FAILED, 0));
    ok(send(&mut e.svm, &w, &[], vec![ix]));

    // Void: Core could not decide; the bond comes back without a reward.
    let c2 = challenger(&mut e);
    let tok2 = balance(&e.svm, &c2.owner_token);
    ok(open(&mut e, &c2, lr::OpenChallengeArgs { kind: lr::KIND_VERDICT, subject: [2; 32], epoch: 7, claim: [0; 32] }));
    let ix = e.resolve_challenge_ix(&core.pubkey(), lr::KIND_VERDICT, &[2; 32], 7, &c2.owner_token, resolve_args(lr::CH_VOID, None), None);
    ok(send(&mut e.svm, &core, &[], vec![ix]));
    assert_eq!(balance(&e.svm, &c2.owner_token), tok2);
}

#[test]
fn upheld_slash_challenge_reverses_the_slash_once() {
    let mut e = configured();
    let (vo, vo_token) = e.wallet(10_000 * ONE);
    let v = Keypair::new();
    e.register_verifier(&vo, &v);
    let ix = e.bond_ix(&vo.pubkey(), &v.pubkey(), &vo_token, 6_000 * ONE);
    ok(send(&mut e.svm, &vo, &[], vec![ix]));
    let core = e.core.insecure_clone();
    let id = sid(41);
    let ix = e.slash_ix(&core.pubkey(), &v.pubkey(), lr::OFFENCE_MINORITY, 4, id);
    ok(send(&mut e.svm, &core, &[], vec![ix]));
    let slashed = 6_000 * ONE * test_params().minority_slash_bps as u64 / 10_000;
    let a = e.agent(&v.pubkey());
    assert_eq!((a.bond, a.slashed_total, a.strikes_total, a.strikes_in_epoch), (6_000 * ONE - slashed, slashed, 1, 1));
    e.fund(&reserve_vault(), 10 * ONE); // the reserve also pays the reward
    let reserve0 = balance(&e.svm, &reserve_vault());

    let c = challenger(&mut e);
    // The epoch must be the slash's own.
    rejects(open(&mut e, &c, lr::OpenChallengeArgs { kind: lr::KIND_SLASH, subject: id, epoch: 5, claim: [0; 32] }), "ChallengeEpoch");
    // A slash that does not exist cannot be contested (no SlashReceipt at that id).
    assert!(open(&mut e, &c, lr::OpenChallengeArgs { kind: lr::KIND_SLASH, subject: sid(999), epoch: 4, claim: [0; 32] }).is_err());
    let tok0 = balance(&e.svm, &c.owner_token);
    ok(open(&mut e, &c, lr::OpenChallengeArgs { kind: lr::KIND_SLASH, subject: id, epoch: 4, claim: [0; 32] }));
    // A slash challenge never holds payouts.
    let g: lr::ChallengeGate = read(&e.svm, &challenge_gate(4));
    assert_eq!(g.open, 0);

    // Upheld without naming the slashed agent's record, or with another agent's: refused.
    let ix = e.resolve_challenge_ix(&core.pubkey(), lr::KIND_SLASH, &id, 4, &c.owner_token, resolve_args(lr::CH_UPHELD, None), None);
    rejects(send(&mut e.svm, &core, &[], vec![ix]), "ChallengeSubject");
    let ix = e.resolve_challenge_ix(&core.pubkey(), lr::KIND_SLASH, &id, 4, &c.owner_token, resolve_args(lr::CH_UPHELD, None),
        Some(c.agent.pubkey()));
    rejects(send(&mut e.svm, &core, &[], vec![ix]), "ChallengeSubject");
    // No root correction through a slash challenge (here epoch 4 is posted so the account resolves).
    post_one_leaf(&mut e, 4, [0; 32], 0);
    let roots = lr::CorrectedRoots { payout_root: [1; 32], lineage_root: [1; 32], record_root: [1; 32], total_units_micro: 1 };
    let ix = e.resolve_challenge_ix(&core.pubkey(), lr::KIND_SLASH, &id, 4, &c.owner_token, resolve_args(lr::CH_UPHELD, Some(roots)), Some(v.pubkey()));
    rejects(send(&mut e.svm, &core, &[], vec![ix]), "ChallengeOutcome");
    let ix = e.resolve_challenge_ix(&core.pubkey(), lr::KIND_SLASH, &id, 4, &c.owner_token, resolve_args(lr::CH_UPHELD, None), Some(v.pubkey()));
    ok(send(&mut e.svm, &core, &[], vec![ix.clone()]));
    let a = e.agent(&v.pubkey());
    assert_eq!((a.bond, a.slashed_total, a.strikes_total, a.strikes_in_epoch), (6_000 * ONE, 0, 0, 0));
    assert_eq!(balance(&e.svm, &bond_vault()), 6_000 * ONE);
    assert_eq!(balance(&e.svm, &reserve_vault()), reserve0 - slashed - REWARD);
    assert_eq!(balance(&e.svm, &c.owner_token), tok0 + REWARD);
    let ch: lr::Challenge = read(&e.svm, &challenge_pda(lr::KIND_SLASH, &id));
    assert_eq!((ch.status, ch.reversed, ch.reward), (lr::CH_UPHELD, slashed, REWARD));
    // Never twice: the challenge is resolved, and its subject can never be challenged again.
    rejects(send(&mut e.svm, &core, &[], vec![ix]), "ChallengeNotOpen");
    let c2 = challenger(&mut e);
    rejects(open(&mut e, &c2, lr::OpenChallengeArgs { kind: lr::KIND_SLASH, subject: id, epoch: 4, claim: [0; 32] }), "already in use");

    // A slash older than the window cannot be contested.
    let id2 = sid(42);
    let ix = e.slash_ix(&core.pubkey(), &v.pubkey(), lr::OFFENCE_MINORITY, 4, id2);
    ok(send(&mut e.svm, &core, &[], vec![ix]));
    warp(&mut e.svm, WINDOW);
    rejects(open(&mut e, &c2, lr::OpenChallengeArgs { kind: lr::KIND_SLASH, subject: id2, epoch: 4, claim: [0; 32] }), "ChallengeWindow");
}

#[test]
fn only_a_registered_agents_current_key_challenges() {
    let mut e = configured();
    let c = challenger(&mut e);
    let args = lr::OpenChallengeArgs { kind: lr::KIND_VERDICT, subject: [3; 32], epoch: 0, claim: [0; 32] };
    // The owner wallet is not the agent's signing key.
    let ix = e.open_challenge_ix(&c.agent.pubkey(), &c.owner.pubkey(), &c.owner.pubkey(), &c.owner_token, args);
    rejects(send(&mut e.svm, &c.owner, &[], vec![ix]), "Unauthorized");
    // An unregistered key has no Agent record.
    let nobody = Keypair::new();
    let ix = e.open_challenge_ix(&nobody.pubkey(), &nobody.pubkey(), &c.owner.pubkey(), &c.owner_token, args);
    assert!(send(&mut e.svm, &c.owner, &[&nobody], vec![ix]).is_err());
    // A payer cannot bond from someone else's token account.
    let (other, other_token) = e.wallet(100 * ONE);
    let _ = other;
    let ix = e.open_challenge_ix(&c.agent.pubkey(), &c.agent.pubkey(), &c.owner.pubkey(), &other_token, args);
    assert!(send(&mut e.svm, &c.owner, &[&c.agent], vec![ix]).is_err());
    // A revoked key is refused.
    let ix = e.owner_agent_ix(&c.owner.pubkey(), &c.agent.pubkey(), lr::instruction::RevokeAgentKey {}.data());
    ok(send(&mut e.svm, &c.owner, &[], vec![ix]));
    rejects(open(&mut e, &c, args), "KeyRevoked");
    // Paused challenges.
    let admin = e.admin.insecure_clone();
    let ix = e.set_challenge_config_ix(&admin.pubkey(), lr::ChallengeConfigArgs { paused: true, ..cfg_args() });
    ok(send(&mut e.svm, &admin, &[], vec![ix]));
    let c2 = challenger(&mut e);
    rejects(open(&mut e, &c2, args), "Paused");
}

#[test]
fn unresolved_challenges_expire_and_release_the_hold() {
    let mut e = configured();
    let c = challenger(&mut e);
    let (w, w_token) = e.wallet(0);
    post_one_leaf(&mut e, 8, wallet_leaf(8, &w.pubkey(), 400), 400);
    let subject = lr::epoch_subject(8);
    let tok0 = balance(&e.svm, &c.owner_token);
    ok(open(&mut e, &c, lr::OpenChallengeArgs { kind: lr::KIND_EPOCH, subject, epoch: 8, claim: [0; 32] }));
    let anyone = funded(&mut e.svm);
    let ix = e.expire_challenge_ix(lr::KIND_EPOCH, &subject, 8, &c.owner_token);
    rejects(send(&mut e.svm, &anyone, &[], vec![ix.clone()]), "ChallengeTimeout");
    warp(&mut e.svm, TIMEOUT);
    let bad = e.expire_challenge_ix(lr::KIND_EPOCH, &subject, 8, &w_token);
    rejects(send(&mut e.svm, &anyone, &[], vec![bad]), "BadDestination");
    ok(send(&mut e.svm, &anyone, &[], vec![ix.clone()]));
    assert_eq!(balance(&e.svm, &c.owner_token), tok0);
    let ch: lr::Challenge = read(&e.svm, &challenge_pda(lr::KIND_EPOCH, &subject));
    assert_eq!(ch.status, lr::CH_EXPIRED);
    rejects(send(&mut e.svm, &anyone, &[], vec![ix]), "ChallengeNotOpen");
    // Core can no longer resolve it, and the epoch pays again.
    let core = e.core.insecure_clone();
    let ix = e.resolve_challenge_ix(&core.pubkey(), lr::KIND_EPOCH, &subject, 8, &c.owner_token, resolve_args(lr::CH_FAILED, None), None);
    rejects(send(&mut e.svm, &core, &[], vec![ix]), "ChallengeNotOpen");
    let ix = wallet_claim(&e, &w.pubkey(), 8, &w.pubkey(), &w_token, 400);
    ok(send(&mut e.svm, &w, &[], vec![ix]));
}

// ---------- internal audit A1 (docs/AUDIT.md, "Onchain") ----------

fn close_ix(e: &Env, account: &Pubkey, owner: &Pubkey) -> anchor_lang::solana_program::instruction::Instruction {
    spl_token_2022::instruction::close_account(&e.line_program, account, owner, owner, &[]).unwrap()
}

/// A1-02: a challenger emptied and closed its refund token account after opening. `resolve_challenge`
/// and `expire_challenge` both deserialized that account, so neither could land: the epoch's gate
/// stayed open and every payout of the epoch was held forever for the price of one bond. The bond
/// of an unusable refund account now goes to the reserve and the challenge still closes.
#[test]
fn audit_a1_02_a_closed_refund_account_cannot_hold_an_epoch_forever() {
    let mut e = configured();
    let c = challenger(&mut e);
    let (w, w_token) = e.wallet(0);
    post_one_leaf(&mut e, 1, wallet_leaf(1, &w.pubkey(), 500), 500);
    let subject = lr::epoch_subject(1);
    ok(open(&mut e, &c, lr::OpenChallengeArgs { kind: lr::KIND_EPOCH, subject, epoch: 1, claim: [1; 32] }));
    ok(open(&mut e, &c, lr::OpenChallengeArgs { kind: lr::KIND_VERDICT, subject: [0x51; 32], epoch: 1, claim: [2; 32] }));
    assert_eq!(read::<lr::ChallengeGate>(&e.svm, &challenge_gate(1)).open, 2);
    // The payer empties its token account and closes it.
    let rest = balance(&e.svm, &c.owner_token);
    let (_sink, sink_token) = e.wallet(0);
    let m = e.line_mint;
    transfer(&mut e.svm, &c.owner, &m, &c.owner_token, &sink_token, rest);
    let ix = close_ix(&e, &c.owner_token, &c.owner.pubkey());
    ok(send(&mut e.svm, &c.owner, &[], vec![ix]));
    assert!(e.svm.get_account(&c.owner_token).map_or(true, |a| a.lamports == 0));

    // Core can still resolve (void would refund; the refund account is gone, so the bond is forfeited).
    let core = e.core.insecure_clone();
    let reserve0 = balance(&e.svm, &reserve_vault());
    let ix = e.resolve_challenge_ix(&core.pubkey(), lr::KIND_EPOCH, &subject, 1, &c.owner_token, resolve_args(lr::CH_VOID, None), None);
    ok(send(&mut e.svm, &core, &[], vec![ix]));
    assert_eq!(balance(&e.svm, &reserve_vault()), reserve0 + BOND);
    assert_eq!(read::<lr::Challenge>(&e.svm, &challenge_pda(lr::KIND_EPOCH, &subject)).status, lr::CH_VOID);
    // Anyone can still expire the other one after the timeout (bond forfeited the same way).
    warp(&mut e.svm, TIMEOUT);
    let ix = e.expire_challenge_ix(lr::KIND_VERDICT, &[0x51; 32], 1, &c.owner_token);
    let k = funded(&mut e.svm);
    ok(send(&mut e.svm, &k, &[], vec![ix]));
    assert_eq!(balance(&e.svm, &reserve_vault()), reserve0 + 2 * BOND);
    assert_eq!(read::<lr::ChallengeGate>(&e.svm, &challenge_gate(1)).open, 0);
    // The epoch pays again.
    let ix = wallet_claim(&e, &w.pubkey(), 1, &w.pubkey(), &w_token, 500);
    ok(send(&mut e.svm, &w, &[], vec![ix]));
    // A redirected refund is still refused (the address stays bound to the challenge).
    let c2 = challenger(&mut e);
    ok(open(&mut e, &c2, lr::OpenChallengeArgs { kind: lr::KIND_VERDICT, subject: [0x52; 32], epoch: 2, claim: [0; 32] }));
    let ix = e.resolve_challenge_ix(&core.pubkey(), lr::KIND_VERDICT, &[0x52; 32], 2, &sink_token, resolve_args(lr::CH_VOID, None), None);
    rejects(send(&mut e.svm, &core, &[], vec![ix]), "BadDestination");
}

/// A1-05: `resolve_challenge` paid `reward` from the compute reserve on every upheld challenge with
/// no bound, so a leaked Core key (opening challenges with a sybil agent and upholding them) drained
/// the reserve past `max_rebate_per_epoch`, the cap the review put on Core's other reserve outflow.
/// Rewards are now capped at `max_rebate_per_epoch` per `epoch_length_s` window.
#[test]
fn audit_a1_05_upheld_rewards_are_capped_per_epoch_length() {
    let mut e = configured();
    let admin = e.admin.insecure_clone();
    let core = e.core.insecure_clone();
    let cap = REWARD * 3 / 2;
    let mut a = config_args(&admin.pubkey(), &core.pubkey());
    a.max_rebate_per_epoch = cap;
    let ix = e.admin_ix(&admin.pubkey(), lr::instruction::SetConfig { args: a }.data());
    ok(send(&mut e.svm, &admin, &[], vec![ix]));
    e.fund(&reserve_vault(), 100 * ONE);
    let c = challenger(&mut e);
    let paid = |e: &mut Env, subject: [u8; 32]| -> u64 {
        let c_open = open(e, &c, lr::OpenChallengeArgs { kind: lr::KIND_VERDICT, subject, epoch: 1, claim: [0; 32] });
        ok(c_open);
        let before = balance(&e.svm, &c.owner_token);
        let ix = e.resolve_challenge_ix(&core.pubkey(), lr::KIND_VERDICT, &subject, 1, &c.owner_token, resolve_args(lr::CH_UPHELD, None), None);
        ok(send(&mut e.svm, &core, &[], vec![ix]));
        balance(&e.svm, &c.owner_token) - before - BOND
    };
    let first: Vec<u64> = (0..3u8).map(|i| paid(&mut e, [0x60 + i; 32])).collect();
    assert_eq!(first, vec![REWARD, cap - REWARD, 0]);
    assert_eq!(read::<lr::Challenge>(&e.svm, &challenge_pda(lr::KIND_VERDICT, &[0x62; 32])).reward, 0);
    // The next epoch length pays again.
    warp(&mut e.svm, 300);
    assert_eq!(paid(&mut e, [0x70; 32]), REWARD);
}
