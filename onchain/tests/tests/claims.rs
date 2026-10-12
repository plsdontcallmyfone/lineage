//! GitHub fee routes and claims (docs/plans/GITHUB-FEE-CLAIMS.md) on LiteSVM against mainnet's
//! pump.fun builds: the exact slice, the attested claim, and the attacks section 7 lists: spoofed
//! attestations, a wrong GitHub id, double claims and replays, expiry, the wallet pin, substituted
//! crank accounts, route changes, and the feature switched off.
#![allow(clippy::result_large_err)]
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use units_onchain_tests::*;

const GH: u64 = 4242;

struct Fx {
    e: Env,
    attestor: Keypair,
}

fn fx() -> Fx {
    let mut e = setup(LineKind::PumpCoin);
    let attestor = Keypair::new();
    let admin = e.admin.insecure_clone();
    let ix = e.set_claim_config_ix(&admin.pubkey(), claim_args(&attestor.pubkey()));
    ok(send(&mut e.svm, &admin, &[], vec![ix]));
    e.set_features(ll::FEATURE_GITHUB_FEES);
    Fx { e, attestor }
}

impl Fx {
    fn routed(&mut self, github_id: u64, bps: u16) -> Launched {
        let l = self.e.launch_agent(Keypair::new(), default_launch_args());
        let ix = self.e.set_fee_route_ix(&l.launcher.pubkey(), &l, github_id, bps);
        ok(send(&mut self.e.svm, &l.launcher, &[], vec![ix]));
        l
    }
    /// A trade on the agent's curve; returns the creator fees waiting.
    fn trade(&mut self, l: &Launched) -> u64 {
        let before = pf::curve_view(&self.e.svm, &l.mint).creator_fee;
        let (t, _, _) = self.e.trader(l, 5_000_000 * ONE);
        ok(self.e.curve_buy(l, &t, 20_000_000 * ONE));
        let fees = pf::curve_view(&self.e.svm, &l.mint).creator_fee;
        assert!(fees > before);
        fees
    }
    fn escrow(&self, id: u64) -> ll::ClaimEscrow {
        read(&self.e.svm, &gh_escrow(id))
    }
    fn msg(&self, id: u64, wallet: &Pubkey, ceiling: u64, expires_at: i64) -> Vec<u8> {
        ll::claim_message(id, wallet, ceiling, self.escrow(id).claim_seq, expires_at)
    }
    /// An honest claim: the attestor signs the current message, the wallet sends both instructions.
    fn claim(&mut self, wallet: &Keypair, token: &Pubkey, id: u64, ceiling: u64) -> litesvm::types::TransactionResult {
        let exp = now(&self.e.svm) + 300;
        let att = ed25519_ix(&self.attestor, &self.msg(id, &wallet.pubkey(), ceiling, exp));
        let ix = self.e.gh_claim_ix(&wallet.pubkey(), token, id, ceiling, exp);
        send(&mut self.e.svm, wallet, &[], vec![att, ix])
    }
}

fn shares(fees: u64, bps: u64) -> (u64, u64, u64) {
    let agent = (fees as u128 * 7000 / 10_000) as u64;
    let gh = (agent as u128 * bps as u128 / 10_000) as u64;
    (agent - gh, gh, fees - agent)
}

#[test]
fn a_route_accrues_the_exact_slice_and_an_attested_claim_pays_it() {
    let mut f = fx();
    let l = f.routed(GH, 2000);
    assert_eq!(read::<ll::AgentLaunch>(&f.e.svm, &l.launch).routes, ll::ROUTE_GITHUB);
    let fees = f.trade(&l);
    let (tr0, cv0) = (balance(&f.e.svm, &treasury()), balance(&f.e.svm, &l.compute_vault));
    ok(f.e.crank_routed(&l));
    let (c, g, p) = shares(fees, 2000);
    assert!(g > 0);
    assert_eq!(balance(&f.e.svm, &l.compute_vault), cv0 + c, "compute share is the agent share less the slice");
    assert_eq!(balance(&f.e.svm, &treasury()), tr0 + p, "protocol share unchanged by the route");
    assert_eq!(balance(&f.e.svm, &gh_vault(GH)), g);
    let r: ll::FeeRoute = read(&f.e.svm, &fee_route(&l.agent.pubkey()));
    assert_eq!((r.github_id, r.bps, r.accrued, r.accrued_total), (GH, 2000, g, g));
    assert_eq!((f.escrow(GH).accrued, f.escrow(GH).claimed, f.escrow(GH).claim_seq), (g, 0, 0));
    let la: ll::AgentLaunch = read(&f.e.svm, &l.launch);
    assert_eq!((la.fees_claimed, la.to_compute, la.to_protocol), (fees, c, p));
    // The claim: a ceiling below the balance pays the ceiling, the next pays the rest.
    let (w, wt) = f.e.wallet(0);
    ok(f.claim(&w, &wt, GH, g - 5));
    assert_eq!((balance(&f.e.svm, &wt), balance(&f.e.svm, &gh_vault(GH))), (g - 5, 5));
    ok(f.claim(&w, &wt, GH, u64::MAX));
    assert_eq!((balance(&f.e.svm, &wt), balance(&f.e.svm, &gh_vault(GH))), (g, 0));
    let es = f.escrow(GH);
    assert_eq!((es.wallet, es.claimed, es.claim_seq), (w.pubkey(), g, 2));
    // Nothing left.
    rejects(f.claim(&w, &wt, GH, u64::MAX), "NothingToClaim");
}

#[test]
fn feature_off_is_the_split_of_today() {
    let mut f = fx();
    let l = f.routed(GH, 3000);
    let plain = f.e.launch_agent(Keypair::new(), default_launch_args());
    // On: the routed agent needs its trailing accounts; an agent without a route does not.
    f.trade(&l);
    rejects(f.e.crank_fees(&l), "MissingRouteAccounts");
    let fees = f.trade(&plain);
    let (tr0, cv0) = (balance(&f.e.svm, &treasury()), balance(&f.e.svm, &plain.compute_vault));
    ok(f.e.crank_fees(&plain));
    let (c, _, p) = shares(fees, 0);
    assert_eq!((balance(&f.e.svm, &plain.compute_vault) - cv0, balance(&f.e.svm, &treasury()) - tr0), (c, p));
    // Off: the routed agent's crank is the eight-account crank with today's two amounts, to the unit.
    f.e.set_features(0);
    let fees = pf::curve_view(&f.e.svm, &l.mint).creator_fee;
    let (tr0, cv0) = (balance(&f.e.svm, &treasury()), balance(&f.e.svm, &l.compute_vault));
    ok(f.e.crank_fees(&l));
    let to_compute = (fees as u128 * 7000 / 10_000) as u64;
    assert_eq!(balance(&f.e.svm, &l.compute_vault) - cv0, to_compute);
    assert_eq!(balance(&f.e.svm, &treasury()) - tr0, fees - to_compute);
    assert_eq!(balance(&f.e.svm, &gh_vault(GH)), 0);
    assert_eq!(balance(&f.e.svm, &l.creator_line_token), 0);
    // Trailing accounts are ignored while off (a client that still sends them changes nothing).
    f.trade(&l);
    let fees = pf::curve_view(&f.e.svm, &l.mint).creator_fee;
    let cv0 = balance(&f.e.svm, &l.compute_vault);
    let k = funded(&mut f.e.svm);
    let line = f.e.line_mint;
    let mut ix = f.e.crank_ix(&l);
    ix.accounts.extend([AccountMeta::new(fee_route(&l.agent.pubkey()), false), AccountMeta::new(gh_escrow(GH), false), AccountMeta::new(gh_vault(GH), false)]);
    ok(send(&mut f.e.svm, &k, &[], vec![cu(600_000), pf::sweep_creator_fee_ix(&k.pubkey(), &l.mint, &line, &l.pump_creator),
        pf::collect_creator_fee_v2_ix(&l.pump_creator, &line), ix]));
    assert_eq!(balance(&f.e.svm, &l.compute_vault) - cv0, (fees as u128 * 7000 / 10_000) as u64);
    assert_eq!(balance(&f.e.svm, &gh_vault(GH)), 0);
    // No new route while off.
    let ix = f.e.set_fee_route_ix(&plain.launcher.pubkey(), &plain, 7, 1000);
    rejects(send(&mut f.e.svm, &plain.launcher, &[], vec![ix]), "FeatureOff");
    // Unknown feature bits are refused.
    let admin = f.e.admin.insecure_clone();
    let ix = f.e.set_features_ix(&admin.pubkey(), 4);
    rejects(send(&mut f.e.svm, &admin, &[], vec![ix]), "InvalidArgs");
    let stranger = funded(&mut f.e.svm);
    let ix = f.e.set_features_ix(&stranger.pubkey(), 3);
    rejects(send(&mut f.e.svm, &stranger, &[], vec![ix]), "Unauthorized");
}

#[test]
fn spoofed_attestations_are_refused() {
    let mut f = fx();
    let l = f.routed(GH, 2000);
    f.trade(&l);
    ok(f.e.crank_routed(&l));
    let g = balance(&f.e.svm, &gh_vault(GH));
    let (w, wt) = f.e.wallet(0);
    let exp = now(&f.e.svm) + 300;
    let msg = f.msg(GH, &w.pubkey(), g, exp);
    let claim = f.e.gh_claim_ix(&w.pubkey(), &wt, GH, g, exp);
    // No attestation at all.
    rejects(send(&mut f.e.svm, &w, &[], vec![claim.clone()]), "BadAttestation");
    // Signed by someone else (the claimant itself).
    rejects(send(&mut f.e.svm, &w, &[], vec![ed25519_ix(&w, &msg), claim.clone()]), "BadAttestation");
    // The attestor's key and the message sit in the instruction's own data, but the offsets point
    // into another instruction, where the claimant's own valid signature is: the precompile passes,
    // the program must not.
    let honest_by_w = ed25519_ix(&w, &msg);
    let mut decoy = ed25519_raw(&f.attestor.pubkey().to_bytes(), &[7u8; 64], &msg);
    for off in [4usize, 8, 14] {
        decoy.data[off..off + 2].copy_from_slice(&1u16.to_le_bytes());
    }
    rejects(send(&mut f.e.svm, &w, &[], vec![decoy, honest_by_w, claim.clone()]), "BadAttestation");
    // An attestation placed after the claim does not count.
    rejects(send(&mut f.e.svm, &w, &[], vec![claim.clone(), ed25519_ix(&f.attestor, &msg)]), "BadAttestation");
    // A real attestation, with any one field changed in the claim: ceiling, expiry, wallet.
    let att = ed25519_ix(&f.attestor, &msg);
    let ix = f.e.gh_claim_ix(&w.pubkey(), &wt, GH, g + 1, exp);
    rejects(send(&mut f.e.svm, &w, &[], vec![att.clone(), ix]), "BadAttestation");
    let ix = f.e.gh_claim_ix(&w.pubkey(), &wt, GH, g, exp + 1);
    rejects(send(&mut f.e.svm, &w, &[], vec![att.clone(), ix]), "BadAttestation");
    let (thief, tt) = f.e.wallet(0);
    let ix = f.e.gh_claim_ix(&thief.pubkey(), &tt, GH, g, exp);
    rejects(send(&mut f.e.svm, &thief, &[], vec![att.clone(), ix]), "BadAttestation");
    // The named wallet paying into someone else's token account.
    let ix = f.e.gh_claim_ix(&w.pubkey(), &tt, GH, g, exp);
    rejects(send(&mut f.e.svm, &w, &[], vec![att.clone(), ix]), "ConstraintTokenOwner");
    // An attestation for another GitHub id does not open this escrow, and this one does not open another.
    let other = f.routed(99, 1000);
    f.trade(&other);
    ok(f.e.crank_routed(&other));
    let att99 = ed25519_ix(&f.attestor, &f.msg(99, &w.pubkey(), g, exp));
    rejects(send(&mut f.e.svm, &w, &[], vec![att99, claim.clone()]), "BadAttestation");
    let ix = f.e.gh_claim_ix(&w.pubkey(), &wt, 99, g, exp);
    rejects(send(&mut f.e.svm, &w, &[], vec![att.clone(), ix]), "BadAttestation");
    // An escrow passed with another id's vault.
    let mut ix = f.e.gh_claim_ix(&w.pubkey(), &wt, GH, g, exp);
    ix.accounts[4] = AccountMeta::new(gh_vault(99), false);
    rejects(send(&mut f.e.svm, &w, &[], vec![att.clone(), ix]), "ConstraintSeeds");
    // Untouched, and the honest claim still works.
    assert_eq!((balance(&f.e.svm, &gh_vault(GH)), f.escrow(GH).claim_seq), (g, 0));
    ok(send(&mut f.e.svm, &w, &[], vec![att, claim]));
    assert_eq!(balance(&f.e.svm, &wt), g);
}

#[test]
fn double_claims_and_replays_are_refused() {
    let mut f = fx();
    let l = f.routed(GH, 2000);
    f.trade(&l);
    ok(f.e.crank_routed(&l));
    let g = balance(&f.e.svm, &gh_vault(GH));
    let (w, wt) = f.e.wallet(0);
    let exp = now(&f.e.svm) + 300;
    let half = g / 2;
    let att = ed25519_ix(&f.attestor, &f.msg(GH, &w.pubkey(), half, exp));
    let claim = f.e.gh_claim_ix(&w.pubkey(), &wt, GH, half, exp);
    ok(send(&mut f.e.svm, &w, &[], vec![att.clone(), claim.clone()]));
    assert_eq!(balance(&f.e.svm, &wt), half);
    // The same attestation again, in a new transaction and twice in one.
    rejects(send(&mut f.e.svm, &w, &[], vec![att.clone(), claim.clone()]), "BadAttestation");
    let mut f2 = fx();
    let l2 = f2.routed(GH, 2000);
    f2.trade(&l2);
    ok(f2.e.crank_routed(&l2));
    let (w2, wt2) = f2.e.wallet(0);
    let exp2 = now(&f2.e.svm) + 300;
    let att2 = ed25519_ix(&f2.attestor, &f2.msg(GH, &w2.pubkey(), 10, exp2));
    let c2 = f2.e.gh_claim_ix(&w2.pubkey(), &wt2, GH, 10, exp2);
    let mut c2b = c2.clone();
    c2b.accounts.push(AccountMeta::new_readonly(Pubkey::new_unique(), false));
    rejects(send(&mut f2.e.svm, &w2, &[], vec![att2, c2, c2b]), "BadAttestation");
    assert_eq!(balance(&f2.e.svm, &wt2), 0);
    // More fees accrue; the used attestation stays dead, a fresh one pays.
    f.trade(&l);
    ok(f.e.crank_routed(&l));
    rejects(send(&mut f.e.svm, &w, &[], vec![att, claim]), "BadAttestation");
    let left = balance(&f.e.svm, &gh_vault(GH));
    assert!(left > g - half, "unclaimed balance kept accruing");
    ok(f.claim(&w, &wt, GH, left));
    assert_eq!((balance(&f.e.svm, &wt), balance(&f.e.svm, &gh_vault(GH))), (half + left, 0));
}

#[test]
fn attestations_expire_and_cannot_be_long_lived() {
    let mut f = fx();
    let l = f.routed(GH, 2000);
    f.trade(&l);
    ok(f.e.crank_routed(&l));
    let (w, wt) = f.e.wallet(0);
    let t = now(&f.e.svm);
    for (exp, why) in [(t - 1, "AttestationExpired"), (t + 601, "AttestationTtl")] {
        let att = ed25519_ix(&f.attestor, &f.msg(GH, &w.pubkey(), 10, exp));
        let ix = f.e.gh_claim_ix(&w.pubkey(), &wt, GH, 10, exp);
        rejects(send(&mut f.e.svm, &w, &[], vec![att, ix]), why);
    }
    // Valid when signed, expired when sent.
    let exp = t + 300;
    let att = ed25519_ix(&f.attestor, &f.msg(GH, &w.pubkey(), 10, exp));
    let ix = f.e.gh_claim_ix(&w.pubkey(), &wt, GH, 10, exp);
    warp(&mut f.e.svm, 301);
    rejects(send(&mut f.e.svm, &w, &[], vec![att, ix]), "AttestationExpired");
    // Paused: no claim, no route change; the crank still accrues.
    let admin = f.e.admin.insecure_clone();
    let ix = f.e.set_claim_config_ix(&admin.pubkey(), ll::ClaimConfigArgs { paused: true, ..claim_args(&f.attestor.pubkey()) });
    ok(send(&mut f.e.svm, &admin, &[], vec![ix]));
    rejects(f.claim(&w, &wt, GH, 10), "Paused");
    let ix = f.e.set_fee_route_ix(&l.launcher.pubkey(), &l, 5, 1000);
    rejects(send(&mut f.e.svm, &l.launcher, &[], vec![ix]), "Paused");
    let before = balance(&f.e.svm, &gh_vault(GH));
    f.trade(&l);
    ok(f.e.crank_routed(&l));
    assert!(balance(&f.e.svm, &gh_vault(GH)) > before);
    // Config: admin only, bounded.
    let stranger = funded(&mut f.e.svm);
    let ix = f.e.set_claim_config_ix(&stranger.pubkey(), claim_args(&stranger.pubkey()));
    rejects(send(&mut f.e.svm, &stranger, &[], vec![ix]), "Unauthorized");
    for bad in [ll::ClaimConfigArgs { max_bps: 5001, ..claim_args(&f.attestor.pubkey()) }, ll::ClaimConfigArgs { min_bps: 3001, ..claim_args(&f.attestor.pubkey()) },
        ll::ClaimConfigArgs { attestor: Pubkey::default(), ..claim_args(&f.attestor.pubkey()) }, ll::ClaimConfigArgs { max_attestation_ttl_s: 0, ..claim_args(&f.attestor.pubkey()) }] {
        let ix = f.e.set_claim_config_ix(&admin.pubkey(), bad);
        rejects(send(&mut f.e.svm, &admin, &[], vec![ix]), "InvalidArgs");
    }
}

#[test]
fn the_first_claim_pins_the_wallet_and_a_new_wallet_waits() {
    let mut f = fx();
    let l = f.routed(GH, 2000);
    f.trade(&l);
    ok(f.e.crank_routed(&l));
    let (w1, t1) = f.e.wallet(0);
    let (w2, t2) = f.e.wallet(0);
    ok(f.claim(&w1, &t1, GH, 100));
    let vault = balance(&f.e.svm, &gh_vault(GH));
    // A valid attestation for another wallet pays nothing: it starts the delay.
    ok(f.claim(&w2, &t2, GH, u64::MAX));
    assert_eq!((balance(&f.e.svm, &t2), balance(&f.e.svm, &gh_vault(GH))), (0, vault));
    let es = f.escrow(GH);
    assert_eq!((es.wallet, es.pending_wallet, es.pending_effective_at), (w1.pubkey(), w2.pubkey(), now(&f.e.svm) + 120));
    rejects(f.claim(&w2, &t2, GH, u64::MAX), "RebindPending");
    // The pinned wallet claims and that cancels the change.
    ok(f.claim(&w1, &t1, GH, 100));
    assert_eq!(f.escrow(GH).pending_wallet, Pubkey::default());
    warp(&mut f.e.svm, 200);
    ok(f.claim(&w2, &t2, GH, u64::MAX));
    assert_eq!(balance(&f.e.svm, &t2), 0, "the cancelled change starts over");
    warp(&mut f.e.svm, 119);
    rejects(f.claim(&w2, &t2, GH, u64::MAX), "RebindPending");
    warp(&mut f.e.svm, 1);
    let left = balance(&f.e.svm, &gh_vault(GH));
    ok(f.claim(&w2, &t2, GH, u64::MAX));
    assert_eq!((balance(&f.e.svm, &t2), f.escrow(GH).wallet), (left, w2.pubkey()));
}

#[test]
fn route_changes_wait_and_never_claw_back() {
    let mut f = fx();
    let l = f.e.launch_agent(Keypair::new(), default_launch_args());
    let owner = l.launcher.insecure_clone();
    // Not the owner; out of bounds; no id.
    let stranger = funded(&mut f.e.svm);
    let ix = f.e.set_fee_route_ix(&stranger.pubkey(), &l, GH, 2000);
    rejects(send(&mut f.e.svm, &stranger, &[], vec![ix]), "Unauthorized");
    let agent_key = l.agent.insecure_clone();
    f.e.svm.airdrop(&agent_key.pubkey(), 10_000_000_000).unwrap();
    let ix = f.e.set_fee_route_ix(&agent_key.pubkey(), &l, GH, 2000);
    rejects(send(&mut f.e.svm, &agent_key, &[], vec![ix]), "Unauthorized");
    for (id, bps) in [(GH, 999u16), (GH, 3001), (0, 2000)] {
        let ix = f.e.set_fee_route_ix(&owner.pubkey(), &l, id, bps);
        rejects(send(&mut f.e.svm, &owner, &[], vec![ix]), "RouteBounds");
    }
    let ix = f.e.set_fee_route_ix(&owner.pubkey(), &l, GH, 3000);
    ok(send(&mut f.e.svm, &owner, &[], vec![ix]));
    f.trade(&l);
    ok(f.e.crank_routed(&l));
    let accrued = balance(&f.e.svm, &gh_vault(GH));
    assert!(accrued > 0);
    // A change is only pending: the next crank still pays the first account.
    let apply = f.e.apply_fee_route_ix(&l.agent.pubkey());
    rejects(send(&mut f.e.svm, &stranger, &[], vec![apply.clone()]), "NoPendingRoute");
    let ix = f.e.set_fee_route_ix(&owner.pubkey(), &l, 77, 1000);
    ok(send(&mut f.e.svm, &owner, &[], vec![ix]));
    let r: ll::FeeRoute = read(&f.e.svm, &fee_route(&l.agent.pubkey()));
    assert_eq!((r.github_id, r.bps, r.pending_github_id, r.pending_bps, r.pending_effective_at), (GH, 3000, 77, 1000, now(&f.e.svm) + 600));
    rejects(send(&mut f.e.svm, &stranger, &[], vec![apply.clone()]), "RouteTimelock");
    f.trade(&l);
    ok(f.e.crank_routed(&l));
    let accrued2 = balance(&f.e.svm, &gh_vault(GH));
    assert!(accrued2 > accrued);
    assert_eq!(balance(&f.e.svm, &gh_vault(77)), 0);
    warp(&mut f.e.svm, 599);
    rejects(send(&mut f.e.svm, &stranger, &[], vec![apply.clone()]), "RouteTimelock");
    warp(&mut f.e.svm, 1);
    ok(send(&mut f.e.svm, &stranger, &[], vec![apply.clone()]));
    f.trade(&l);
    ok(f.e.crank_routed(&l));
    assert!(balance(&f.e.svm, &gh_vault(77)) > 0, "fees now accrue to the new account");
    // What the first account accrued is still there and still its to claim.
    assert_eq!(balance(&f.e.svm, &gh_vault(GH)), accrued2);
    let (w, wt) = f.e.wallet(0);
    ok(f.claim(&w, &wt, GH, u64::MAX));
    assert_eq!(balance(&f.e.svm, &wt), accrued2);
    let r: ll::FeeRoute = read(&f.e.svm, &fee_route(&l.agent.pubkey()));
    assert_eq!((r.github_id, r.bps, r.changes, r.pending_effective_at), (77, 1000, 1, 0));
    assert_eq!(r.accrued_total, accrued2 + balance(&f.e.svm, &gh_vault(77)));
}

#[test]
fn the_crank_refuses_substituted_route_accounts() {
    let mut f = fx();
    let a = f.routed(GH, 2000);
    let b = f.routed(99, 1000);
    f.trade(&a);
    let k = funded(&mut f.e.svm);
    let line = f.e.line_mint;
    ok(send(&mut f.e.svm, &k, &[], vec![cu(600_000), create_ata_ix(&k.pubkey(), &a.pump_creator, &line, &f.e.line_program),
        pf::sweep_creator_fee_ix(&k.pubkey(), &a.mint, &line, &a.pump_creator), pf::collect_creator_fee_v2_ix(&a.pump_creator, &line)]));
    let (thief, thief_token) = f.e.wallet(0);
    let _ = thief;
    let honest = [AccountMeta::new(fee_route(&a.agent.pubkey()), false), AccountMeta::new(gh_escrow(GH), false), AccountMeta::new(gh_vault(GH), false)];
    let attempt = |f: &mut Fx, i: usize, key: Pubkey, why: &str| {
        let mut ix = f.e.crank_ix(&a);
        let mut m = honest.to_vec();
        m[i] = AccountMeta::new(key, false);
        ix.accounts.extend(m);
        rejects(send(&mut f.e.svm, &k, &[], vec![ix]), why);
    };
    // Another agent's route (a smaller share), another id's escrow, another id's vault, the caller's own token account.
    attempt(&mut f, 0, fee_route(&b.agent.pubkey()), "WrongRouteAccount");
    attempt(&mut f, 1, gh_escrow(99), "WrongRouteAccount");
    attempt(&mut f, 2, gh_vault(99), "WrongRouteAccount");
    attempt(&mut f, 2, thief_token, "WrongRouteAccount");
    // A look-alike route owned by another program.
    let fake = Pubkey::new_unique();
    let mut acct = f.e.svm.get_account(&fee_route(&a.agent.pubkey())).unwrap();
    acct.owner = lr::ID;
    f.e.svm.set_account(fake, acct).unwrap();
    attempt(&mut f, 0, fake, "AccountOwnedByWrongProgram");
    // Fewer accounts than the route needs.
    let mut ix = f.e.crank_ix(&a);
    ix.accounts.extend(honest[..2].to_vec());
    rejects(send(&mut f.e.svm, &k, &[], vec![ix]), "MissingRouteAccounts");
    // The honest crank.
    let mut ix: Instruction = f.e.crank_ix(&a);
    ix.accounts.extend(honest.to_vec());
    ok(send(&mut f.e.svm, &k, &[], vec![ix]));
    assert!(balance(&f.e.svm, &gh_vault(GH)) > 0);
    assert_eq!((balance(&f.e.svm, &gh_vault(99)), balance(&f.e.svm, &thief_token)), (0, 0));
}
