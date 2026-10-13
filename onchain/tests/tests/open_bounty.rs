//! `units_bounty` (docs/plans/OPEN-BOUNTIES.md option A): bounties any wallet posts from its own
//! `$UNITS`, paid to the author of the earliest accepted generation that meets the terms, proven by
//! Core's result leaf against the registry's `Epoch.record_root`; refunded to the funder at expiry.
//! Leaves, roots and proofs come from `make-fixtures.ts`, built with packages/core records.ts
//! `resultLeaf`, so a Core-built record root is proven to pay here.
//!
//! The program is loaded from `target/bounty/units_bounty.so` (UNITS_BOUNTY_SO names another build:
//! onchain/scripts/bounty-mutations.sh runs the attack tests against builds with one check removed
//! and expects each to fail).
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::{bpf_loader_upgradeable, system_program};
use anchor_lang::{InstructionData, ToAccountMetas};
use litesvm::types::TransactionResult;
use serde_json::Value;
use units_bounty as lb;
use units_onchain_tests::*;

const TTL: i64 = 3 * 86_400;
const GRACE: u32 = 7_200;
const CONTEST: u32 = 1_800;

fn bpda(seeds: &[&[u8]]) -> Pubkey {
    pda_of(seeds, &lb::ID)
}
fn bconfig() -> Pubkey {
    bpda(&[lb::CONFIG_SEED])
}
fn bauthority() -> Pubkey {
    bpda(&[lb::AUTHORITY_SEED])
}
fn fee_vault() -> Pubkey {
    bpda(&[lb::FEE_VAULT_SEED])
}
fn bounty_pda(funder: &Pubkey, id: u64) -> Pubkey {
    bpda(&[lb::BOUNTY_SEED, funder.as_ref(), &id.to_le_bytes()])
}
fn vault_of(bounty: &Pubkey) -> Pubkey {
    bpda(&[lb::VAULT_SEED, bounty.as_ref()])
}
fn settings() -> lb::Settings {
    lb::Settings { min_amount: ONE, min_ttl_s: 3_600, max_ttl_s: 30 * 86_400, refund_grace_s: GRACE, contest_s: CONTEST, fee_bps: 0, paused: false }
}
fn hex(v: &Value) -> [u8; 32] {
    hex32(v.as_str().unwrap())
}

struct World {
    e: Env,
    fx: Value,
    /// Launched agents S and H (authors in the fixtures) and a funder that owns no agent.
    s: Launched,
    h: Launched,
    funder: Keypair,
    funder_token: Pubkey,
}

fn init_ix(line: (Pubkey, Pubkey), signer: &Pubkey, admin: &Pubkey, s: lb::Settings) -> Instruction {
    Instruction {
        program_id: lb::ID,
        accounts: lb::accounts::Initialize {
            config: bconfig(), upgrade_authority: *signer, program_data: pda_of(&[lb::ID.as_ref()], &bpf_loader_upgradeable::ID),
            registry_config: registry_config(), mint: line.0, authority: bauthority(), fee_vault: fee_vault(), token_program: line.1,
            system_program: system_program::ID,
        }.to_account_metas(None),
        data: lb::instruction::Initialize { admin: *admin, settings: s }.data(),
    }
}
fn admin_ix(admin: &Pubkey, data: Vec<u8>) -> Instruction {
    Instruction { program_id: lb::ID, accounts: lb::accounts::AdminOnly { config: bconfig(), admin: *admin }.to_account_metas(None), data }
}
fn set_settings_ix(admin: &Pubkey, s: lb::Settings) -> Instruction {
    admin_ix(admin, lb::instruction::SetSettings { settings: s }.data())
}

fn load(e: &mut Env) {
    let so = std::env::var("UNITS_BOUNTY_SO").map(|p| manifest("..").join(p)).unwrap_or_else(|_| manifest("../target/bounty/units_bounty.so"));
    e.svm.add_program_from_file(lb::ID, so).expect("build units_bounty first (onchain/README.md)");
}

fn world() -> World {
    let mut e = setup(LineKind::PumpCoin);
    load(&mut e);
    let fx = fixtures();
    let mut args = default_launch_args();
    args.hosted = false;
    let s = e.launch_agent(seeded(32), args.clone());
    args.hosted = true;
    let h = e.launch_agent(seeded(33), args);
    assert_eq!(s.agent.pubkey(), b58_pubkey(fx["bounty"]["keys"]["S"].as_str().unwrap()));
    assert_eq!(h.agent.pubkey(), b58_pubkey(fx["bounty"]["keys"]["H"].as_str().unwrap()));
    let admin = e.admin.insecure_clone();
    let line = (e.line_mint, e.line_program);
    install_program_data(&mut e.svm, &lb::ID, &admin.pubkey());
    ok(send(&mut e.svm, &admin, &[], vec![init_ix(line, &admin.pubkey(), &admin.pubkey(), settings())]));
    let (funder, funder_token) = e.wallet(1_000 * ONE);
    // the fixtures' accepted_at values are relative to this clock
    assert_eq!(now(&e.svm), fx["open_bounty"]["now"].as_i64().unwrap());
    World { e, fx, s, h, funder, funder_token }
}

impl World {
    fn post(&mut self, epoch: u64) {
        let root = hex(&self.fx["open_bounty"]["roots"][epoch.to_string()]);
        let core = self.e.core.insecure_clone();
        let ix = self.e.post_epoch_ix(&core.pubkey(), lr::PostEpochArgs { epoch, payout_root: [0; 32], lineage_root: [0; 32], total_units_micro: 0,
            pool_amount: 0, rebate_amount: 0, record_root: root });
        ok(send(&mut self.e.svm, &core, &[], vec![ix]));
    }
    fn open_args(&self, id: u64, amount: u64, min_bps: u16) -> lb::OpenArgs {
        lb::OpenArgs { bounty_id: id, amount, terms_digest: [id as u8; 32], lineage_id: hex(&self.fx["open_bounty"]["lineage"]),
            target_digest: hex(&self.fx["open_bounty"]["target_ir_digest"]), min_improvement_bps: min_bps, deadline: now(&self.e.svm) + TTL }
    }
    fn open_ix(&self, funder: &Pubkey, funder_token: &Pubkey, a: lb::OpenArgs) -> Instruction {
        let b = bounty_pda(funder, a.bounty_id);
        Instruction {
            program_id: lb::ID,
            accounts: lb::accounts::OpenBounty {
                config: bconfig(), registry_config: registry_config(), funder: *funder, funder_token: *funder_token, bounty: b, vault: vault_of(&b),
                authority: bauthority(), mint: self.e.line_mint, token_program: self.e.line_program, system_program: system_program::ID,
            }.to_account_metas(None),
            data: lb::instruction::OpenBounty { args: a }.data(),
        }
    }
    fn open_as(&mut self, funder: &Keypair, token: &Pubkey, a: lb::OpenArgs) -> TransactionResult {
        let ix = self.open_ix(&funder.pubkey(), token, a);
        send(&mut self.e.svm, funder, &[], vec![ix])
    }
    /// The world's funder opens bounty `id`: `amount` for at least 10% on "ir".
    fn open(&mut self, id: u64, amount: u64) -> Pubkey {
        let (f, t) = (self.funder.insecure_clone(), self.funder_token);
        let a = self.open_args(id, amount, 1_000);
        ok(self.open_as(&f, &t, a));
        bounty_pda(&f.pubkey(), id)
    }
    /// Claim args straight from a fixture result.
    fn claim_args(&self, r: &str) -> lb::ClaimArgs {
        let x = &self.fx["open_bounty"]["results"][r];
        let (target, is_list) = match &x["target"] {
            Value::String(s) => (vec![s.clone()], false),
            Value::Array(a) => (a.iter().map(|v| v.as_str().unwrap().to_string()).collect(), true),
            _ => unreachable!(),
        };
        lb::ClaimArgs { epoch: x["epoch"].as_u64().unwrap(), gen_id: hex(&x["gen_id"]), height: x["height"].as_u64().unwrap(),
            improvement_bps: x["improvement_bps"].as_u64().unwrap(), accepted_at: x["accepted_at"].as_i64().unwrap(),
            author: b58_pubkey(x["author"].as_str().unwrap()), target, target_is_list: is_list, proof: x["proof"].as_array().unwrap().iter().map(hex).collect() }
    }
    fn claim_ix(&self, bounty: &Pubkey, a: lb::ClaimArgs, epoch_acct: Pubkey, compute: Pubkey) -> Instruction {
        Instruction {
            program_id: lb::ID,
            accounts: lb::accounts::Claim { config: bconfig(), bounty: *bounty, registry_epoch: epoch_acct, challenge_config: challenge_config(),
                challenge_gate: challenge_gate(a.epoch), winner_compute: compute }.to_account_metas(None),
            data: lb::instruction::Claim { args: a }.data(),
        }
    }
    /// Anyone sends the claim; the paid account is the compute vault of the leaf's author.
    fn claim_with(&mut self, bounty: &Pubkey, a: lb::ClaimArgs) -> TransactionResult {
        let caller = funded(&mut self.e.svm);
        let ix = self.claim_ix(bounty, a.clone(), epoch_pda(a.epoch), compute_vault(&a.author));
        send(&mut self.e.svm, &caller, &[], vec![cu(400_000), ix])
    }
    fn claim(&mut self, bounty: &Pubkey, r: &str) -> TransactionResult {
        let a = self.claim_args(r);
        self.claim_with(bounty, a)
    }
    fn pay_accounts(&self, bounty: &Pubkey) -> lb::accounts::Pay {
        let b: lb::Bounty = read(&self.e.svm, bounty);
        lb::accounts::Pay { config: bconfig(), bounty: *bounty, vault: vault_of(bounty), authority: bauthority(), funder: b.funder,
            winner_compute: compute_vault(&b.winner), fee_vault: fee_vault(), mint: self.e.line_mint, token_program: self.e.line_program }
    }
    fn pay_with(&mut self, accounts: lb::accounts::Pay) -> TransactionResult {
        let caller = funded(&mut self.e.svm);
        send(&mut self.e.svm, &caller, &[], vec![Instruction { program_id: lb::ID, accounts: accounts.to_account_metas(None), data: lb::instruction::Pay {}.data() }])
    }
    fn pay(&mut self, bounty: &Pubkey) -> TransactionResult {
        let a = self.pay_accounts(bounty);
        self.pay_with(a)
    }
    fn refund_accounts(&self, bounty: &Pubkey, funder_token: &Pubkey) -> lb::accounts::Refund {
        let b: lb::Bounty = read(&self.e.svm, bounty);
        lb::accounts::Refund { config: bconfig(), bounty: *bounty, vault: vault_of(bounty), authority: bauthority(), funder: b.funder, funder_token: *funder_token,
            mint: self.e.line_mint, token_program: self.e.line_program }
    }
    /// Anyone sends the refund; `to` is where the escrow should go.
    fn refund_to(&mut self, bounty: &Pubkey, to: &Pubkey) -> TransactionResult {
        let caller = funded(&mut self.e.svm);
        let ix = Instruction { program_id: lb::ID, accounts: self.refund_accounts(bounty, to).to_account_metas(None), data: lb::instruction::Refund {}.data() };
        send(&mut self.e.svm, &caller, &[], vec![ix])
    }
    /// The removed `cancel` instruction as a client of the earlier build sent it: its 8-byte name
    /// (sha256("global:cancel")[..8]), the refund accounts, the registry's Config and the signer.
    fn old_cancel_as(&mut self, bounty: &Pubkey, signer: &Keypair, to: &Pubkey) -> TransactionResult {
        let mut accounts = self.refund_accounts(bounty, to).to_account_metas(None);
        accounts.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(registry_config(), false));
        accounts.push(anchor_lang::solana_program::instruction::AccountMeta::new_readonly(signer.pubkey(), true));
        let name = anchor_lang::solana_program::hash::hash(b"global:cancel").to_bytes()[..8].to_vec();
        send(&mut self.e.svm, signer, &[], vec![Instruction { program_id: lb::ID, accounts, data: name }])
    }
    fn bounty(&self, b: &Pubkey) -> lb::Bounty {
        read(&self.e.svm, b)
    }
    fn bal(&self, a: &Pubkey) -> u64 {
        balance(&self.e.svm, a)
    }
    fn gone(&self, a: &Pubkey) -> bool {
        self.e.svm.get_account(a).map_or(true, |x| x.lamports == 0)
    }
    fn set(&mut self, s: lb::Settings) {
        let admin = self.e.admin.insecure_clone();
        ok(send(&mut self.e.svm, &admin, &[], vec![set_settings_ix(&admin.pubkey(), s)]));
    }
}

#[test]
fn rust_result_leaf_matches_core() {
    let fx = fixtures();
    let mut n = 0;
    for (_, r) in fx["open_bounty"]["results"].as_object().unwrap() {
        let (t, l) = match &r["target"] {
            Value::String(s) => (vec![s.clone()], false),
            Value::Array(a) => (a.iter().map(|v| v.as_str().unwrap().to_string()).collect::<Vec<_>>(), true),
            _ => unreachable!(),
        };
        let tj = lb::target_json(&t, l).unwrap();
        let args = (r["accepted_at"].as_u64().unwrap(), b58_pubkey(r["author"].as_str().unwrap()), r["epoch"].as_u64().unwrap(), hex(&r["gen_id"]),
            r["height"].as_u64().unwrap(), r["improvement_bps"].as_u64().unwrap(), hex(&r["lineage_id"]));
        let json = lb::result_json(args.0, &args.1, args.2, &args.3, args.4, args.5, &args.6, &tj);
        assert_eq!(String::from_utf8(json).unwrap(), r["json"].as_str().unwrap());
        assert_eq!(lb::result_leaf(args.0, &args.1, args.2, &args.3, args.4, args.5, &args.6, &tj), hex(&r["leaf"]));
        n += 1;
    }
    assert_eq!(n, 10);
    assert_eq!(lb::target_digest(b"\"ir\""), hex(&fx["open_bounty"]["target_ir_digest"]));
}

#[test]
fn initialize_is_the_upgrade_authority_only_and_binds_the_registry() {
    let mut e = setup(LineKind::PumpCoin);
    load(&mut e);
    let admin = e.admin.insecure_clone();
    let line = (e.line_mint, e.line_program);
    install_program_data(&mut e.svm, &lb::ID, &admin.pubkey());
    let stranger = funded(&mut e.svm);
    rejects(send(&mut e.svm, &stranger, &[], vec![init_ix(line, &stranger.pubkey(), &stranger.pubkey(), settings())]), "Unauthorized");
    let mut bad = settings();
    bad.fee_bps = 10_000;
    rejects(send(&mut e.svm, &admin, &[], vec![init_ix(line, &admin.pubkey(), &admin.pubkey(), bad)]), "InvalidArgs");
    // another mint than the registry's is refused: the escrow and the compute vaults share one mint
    let (other_mint, _) = create_line(&mut e.svm, &admin, LineKind::Pump);
    let mut ix = init_ix(line, &admin.pubkey(), &admin.pubkey(), settings());
    ix.accounts[4].pubkey = other_mint;
    rejects(send(&mut e.svm, &admin, &[], vec![ix]), "ConstraintHasOne");
    ok(send(&mut e.svm, &admin, &[], vec![init_ix(line, &admin.pubkey(), &admin.pubkey(), settings())]));
    let c: lb::Config = read(&e.svm, &bconfig());
    assert_eq!((c.admin, c.mint, c.token_program, c.launch_program, c.settings), (admin.pubkey(), e.line_mint, e.line_program, ll::ID, settings()));
    // once
    assert!(send(&mut e.svm, &admin, &[], vec![init_ix(line, &admin.pubkey(), &admin.pubkey(), settings())]).is_err());
}

#[test]
fn a_wallet_with_no_agent_posts_and_the_earliest_generation_that_meets_the_terms_is_paid() {
    let mut w = world();
    w.post(1);
    let fk = w.funder.pubkey();
    let sol_before = w.e.svm.get_account(&fk).unwrap().lamports;
    let b = w.open(1, 50 * ONE);
    let x = w.bounty(&b);
    assert_eq!((x.funder, x.amount, x.status, x.min_epoch, x.min_improvement_bps, x.fee_bps, x.created_at), (fk, 50 * ONE, lb::STATUS_OPEN, 2, 1_000, 0, NOW));
    assert_eq!((x.refund_after, x.contest_s, x.winner), (NOW + TTL + GRACE as i64, CONTEST, Pubkey::default()));
    assert_eq!((w.bal(&w.funder_token), w.bal(&vault_of(&b))), (950 * ONE, 50 * ONE));
    // nothing to claim against before the epoch that holds the generation is posted
    rejects(w.claim(&b, "r3"), "AccountNotInitialized");
    assert!(w.pay(&b).is_err()); // nobody to pay
    warp(&mut w.e.svm, 600);
    w.post(2);
    ok(w.claim(&b, "r3"));
    let x = w.bounty(&b);
    let t = now(&w.e.svm);
    assert_eq!((x.winner, x.win_height, x.win_epoch, x.win_improvement_bps, x.claimed_at, x.contest_until), (w.s.agent.pubkey(), 4, 2, 1_200, t, t + CONTEST as i64));
    assert_eq!(x.win_leaf, hex(&w.fx["open_bounty"]["results"]["r3"]["leaf"]));
    // not payable while an earlier generation may still be named
    rejects(w.pay(&b), "ContestOpen");
    warp(&mut w.e.svm, CONTEST as i64);
    let before = w.bal(&w.s.compute_vault);
    ok(w.pay(&b));
    assert_eq!(w.bal(&w.s.compute_vault), before + 50 * ONE);
    assert!(w.gone(&vault_of(&b)));
    let x = w.bounty(&b);
    assert_eq!((x.status, x.paid, x.fee_paid, x.closed_at), (lb::STATUS_PAID, 50 * ONE, 0, now(&w.e.svm)));
    // the funder paid the bounty account's rent and fees, and got the vault's rent back
    assert!(sol_before - w.e.svm.get_account(&fk).unwrap().lamports < 5_000_000);
    // replays: a second claim, a second payout and a refund of a paid bounty are refused
    rejects(w.claim(&b, "r3"), "BountyClosed");
    assert!(w.pay(&b).is_err());
    warp(&mut w.e.svm, TTL + GRACE as i64);
    let ft = w.funder_token;
    assert!(w.refund_to(&b, &ft).is_err());
    assert_eq!(w.bal(&w.funder_token), 950 * ONE);
}

#[test]
fn an_earlier_generation_replaces_a_standing_claim_and_a_replayed_claim_does_not() {
    let mut w = world();
    w.post(1);
    let b = w.open(1, 20 * ONE);
    w.post(2);
    // whoever sends first: the later generation (height 5, by H) stands
    ok(w.claim(&b, "r2"));
    assert_eq!((w.bounty(&b).winner, w.bounty(&b).win_height), (w.h.agent.pubkey(), 5));
    let until = w.bounty(&b).contest_until;
    // the same claim again, and a later generation, change nothing
    rejects(w.claim(&b, "r2"), "NotEarlier");
    rejects(w.claim(&b, "r10"), "NotEarlier");
    // the earliest (height 4, by S) replaces it; the contest time does not start again
    warp(&mut w.e.svm, 60);
    ok(w.claim(&b, "r3"));
    assert_eq!((w.bounty(&b).winner, w.bounty(&b).win_height, w.bounty(&b).contest_until), (w.s.agent.pubkey(), 4, until));
    rejects(w.claim(&b, "r2"), "NotEarlier");
    warp(&mut w.e.svm, CONTEST as i64);
    let (s0, h0) = (w.bal(&w.s.compute_vault), w.bal(&w.h.compute_vault));
    ok(w.pay(&b));
    assert_eq!((w.bal(&w.s.compute_vault), w.bal(&w.h.compute_vault)), (s0 + 20 * ONE, h0));
}

#[test]
fn after_the_contest_time_the_standing_claim_cannot_be_replaced() {
    let mut w = world();
    w.post(1);
    let b = w.open(1, 20 * ONE);
    w.post(2);
    ok(w.claim(&b, "r2"));
    warp(&mut w.e.svm, CONTEST as i64);
    rejects(w.claim(&b, "r3"), "ContestOver");
    let h0 = w.bal(&w.h.compute_vault);
    ok(w.pay(&b));
    assert_eq!(w.bal(&w.h.compute_vault), h0 + 20 * ONE);
}

#[test]
fn a_wrong_winner_is_refused() {
    let mut w = world();
    w.post(1);
    let b = w.open(1, 20 * ONE);
    w.post(2);
    let (sk, hk) = (w.s.agent.pubkey(), w.h.agent.pubkey());
    // the real leaf with another author in its place (the attacker's own agent)
    let mut a = w.claim_args("r3");
    a.author = hk;
    rejects(w.claim_with(&b, a), "BadProof");
    // the real leaf, but the account to pay is another agent's compute vault
    let a = w.claim_args("r3");
    let caller = funded(&mut w.e.svm);
    let ix = w.claim_ix(&b, a.clone(), epoch_pda(2), compute_vault(&hk));
    rejects(send(&mut w.e.svm, &caller, &[], vec![cu(400_000), ix]), "ConstraintSeeds");
    // ... or a token account the attacker owns
    let (_, mine) = w.e.wallet(0);
    let ix = w.claim_ix(&b, a, epoch_pda(2), mine);
    rejects(send(&mut w.e.svm, &caller, &[], vec![cu(400_000), ix]), "ConstraintSeeds");
    // a better result than was measured, an earlier height than it has, a later acceptance
    let mut a = w.claim_args("r4");
    a.improvement_bps = 5_000;
    rejects(w.claim_with(&b, a), "BadProof");
    let mut a = w.claim_args("r2");
    a.height = 1;
    rejects(w.claim_with(&b, a), "BadProof");
    let mut a = w.claim_args("r5");
    a.accepted_at = NOW + 10;
    rejects(w.claim_with(&b, a), "BadProof");
    // a result below the required improvement, one accepted before the bounty existed, one on
    // another metric, one on another unit, one in an epoch posted before the bounty opened
    rejects(w.claim(&b, "r4"), "ImprovementTooLow");
    rejects(w.claim(&b, "r5"), "BeforeOpen");
    rejects(w.claim(&b, "r7"), "WrongTarget");
    rejects(w.claim(&b, "r6"), "BadProof");
    rejects(w.claim(&b, "r1"), "BeforeOpen");
    // a leaf of another kind from the same root (a contribution) proves no result
    let mut a = w.claim_args("r3");
    a.proof = w.fx["open_bounty"]["contribution_c2"]["proof"].as_array().unwrap().iter().map(hex).collect();
    rejects(w.claim_with(&b, a), "BadProof");
    // a proof against another epoch's root: the epoch account must be the one the leaf names
    let a = w.claim_args("r3");
    let ix = w.claim_ix(&b, a, epoch_pda(1), compute_vault(&sk));
    rejects(send(&mut w.e.svm, &caller, &[], vec![cu(400_000), ix]), "ConstraintSeeds");
    // an author that was never launched has no compute vault: its claim cannot stand
    rejects(w.claim(&b, "r9"), "AccountNotInitialized");
    assert_eq!(w.bounty(&b).winner, Pubkey::default());
    // the payout goes only to the standing winner's vault
    ok(w.claim(&b, "r3"));
    warp(&mut w.e.svm, CONTEST as i64);
    let mut p = w.pay_accounts(&b);
    p.winner_compute = compute_vault(&hk);
    rejects(w.pay_with(p), "ConstraintSeeds");
    let mut p = w.pay_accounts(&b);
    p.fee_vault = compute_vault(&hk);
    rejects(w.pay_with(p), "ConstraintSeeds");
    let s0 = w.bal(&w.s.compute_vault);
    ok(w.pay(&b));
    assert_eq!(w.bal(&w.s.compute_vault), s0 + 20 * ONE);
}

#[test]
fn a_forged_record_root_is_refused() {
    let mut w = world();
    w.post(1);
    let b = w.open(1, 20 * ONE);
    // an account with the bytes of an Epoch whose root holds the leaf, but not the registry's
    w.post(2);
    let real = w.e.svm.get_account(&epoch_pda(2)).unwrap();
    let fake = Pubkey::new_unique();
    w.e.svm.set_account(fake, solana_account::Account { owner: lb::ID, ..real.clone() }).unwrap();
    let a = w.claim_args("r3");
    let caller = funded(&mut w.e.svm);
    let ix = w.claim_ix(&b, a.clone(), fake, compute_vault(&a.author));
    assert!(send(&mut w.e.svm, &caller, &[], vec![cu(400_000), ix]).is_err());
    // registry-owned bytes at another address
    w.e.svm.set_account(fake, real).unwrap();
    let ix = w.claim_ix(&b, a.clone(), fake, compute_vault(&a.author));
    rejects(send(&mut w.e.svm, &caller, &[], vec![cu(400_000), ix]), "ConstraintSeeds");
    assert_eq!(w.bounty(&b).winner, Pubkey::default());
}

#[test]
fn a_claim_after_expiry_is_refused_and_the_funder_is_refunded() {
    let mut w = world();
    w.post(1);
    let b = w.open(1, 30 * ONE);
    let ft = w.funder_token;
    rejects(w.refund_to(&b, &ft), "NotExpired");
    // epoch 2 is posted after the deadline: a generation that late does not qualify
    warp(&mut w.e.svm, TTL + 1);
    w.post(2);
    rejects(w.claim(&b, "r3"), "Late");
    rejects(w.refund_to(&b, &ft), "NotExpired");
    warp(&mut w.e.svm, GRACE as i64);
    rejects(w.claim(&b, "r3"), "Expired");
    // anyone sends the refund, and it can only go to a token account of the funder
    let (_, thief_token) = w.e.wallet(0);
    rejects(w.refund_to(&b, &thief_token), "ConstraintTokenOwner");
    let sol = w.e.svm.get_account(&w.funder.pubkey()).unwrap().lamports;
    ok(w.refund_to(&b, &ft));
    assert_eq!(w.bal(&w.funder_token), 1_000 * ONE);
    assert!(w.gone(&vault_of(&b)));
    assert!(w.e.svm.get_account(&w.funder.pubkey()).unwrap().lamports > sol); // the vault's rent
    assert_eq!(w.bounty(&b).status, lb::STATUS_REFUNDED);
    assert!(w.refund_to(&b, &ft).is_err());
    rejects(w.claim(&b, "r3"), "BountyClosed");
}

#[test]
fn a_claim_made_in_time_is_paid_even_after_the_refund_time() {
    let mut w = world();
    w.post(1);
    let b = w.open(1, 30 * ONE);
    w.post(2);
    warp(&mut w.e.svm, TTL + GRACE as i64 - 5);
    ok(w.claim(&b, "r3"));
    warp(&mut w.e.svm, CONTEST as i64);
    let ft = w.funder_token;
    rejects(w.refund_to(&b, &ft), "ClaimStanding");
    let s0 = w.bal(&w.s.compute_vault);
    ok(w.pay(&b));
    assert_eq!(w.bal(&w.s.compute_vault), s0 + 30 * ONE);
}

#[test]
fn a_claim_waits_for_the_registry_challenge_hold() {
    let mut w = world();
    let admin = w.e.admin.insecure_clone();
    let ix = w.e.set_challenge_config_ix(&admin.pubkey(), lr::ChallengeConfigArgs { window_s: 600, bond: ONE, reward: 0, resolve_timeout_s: 3_600, paused: false });
    ok(send(&mut w.e.svm, &admin, &[], vec![ix]));
    w.post(1);
    let b = w.open(1, 20 * ONE);
    w.post(2);
    rejects(w.claim(&b, "r3"), "Held");
    warp(&mut w.e.svm, 600);
    ok(w.claim(&b, "r3"));
}

#[test]
fn a_bounty_for_a_unit_or_metric_that_does_not_exist_pays_nobody_and_refunds() {
    let mut w = world();
    w.post(1);
    let (f, ft) = (w.funder.insecure_clone(), w.funder_token);
    // no unit, no metric, no improvement, all of it: refused at the open
    for edit in [|a: &mut lb::OpenArgs| a.lineage_id = [0; 32], |a: &mut lb::OpenArgs| a.target_digest = [0; 32],
        |a: &mut lb::OpenArgs| a.min_improvement_bps = 0, |a: &mut lb::OpenArgs| a.min_improvement_bps = 10_000] {
        let mut a = w.open_args(9, 10 * ONE, 1_000);
        edit(&mut a);
        rejects(w.open_as(&f, &ft, a), "InvalidArgs");
    }
    // a unit nobody has, and a metric the unit does not have: the chain cannot know, so the escrow
    // simply never matches a result leaf and comes back whole
    let mut a = w.open_args(1, 10 * ONE, 1_000);
    a.lineage_id = [7; 32];
    ok(w.open_as(&f, &ft, a));
    let mut a = w.open_args(2, 10 * ONE, 1_000);
    a.target_digest = [9; 32];
    ok(w.open_as(&f, &ft, a));
    let (b1, b2) = (bounty_pda(&f.pubkey(), 1), bounty_pda(&f.pubkey(), 2));
    w.post(2);
    for r in ["r2", "r3", "r6", "r7", "r10"] {
        assert!(w.claim(&b1, r).is_err());
        assert!(w.claim(&b2, r).is_err());
    }
    rejects(w.claim(&b1, "r3"), "BadProof");
    rejects(w.claim(&b2, "r3"), "WrongTarget");
    warp(&mut w.e.svm, TTL + GRACE as i64 + 1);
    ok(w.refund_to(&b1, &ft));
    ok(w.refund_to(&b2, &ft));
    assert_eq!(w.bal(&w.funder_token), 1_000 * ONE);
}

#[test]
fn a_funder_cannot_take_another_funders_escrow() {
    let mut w = world();
    w.post(1);
    let b = w.open(1, 40 * ONE);
    let (mallory, mallory_token) = w.e.wallet(100 * ONE);
    let a = w.open_args(1, 5 * ONE, 1_000);
    ok(w.open_as(&mallory, &mallory_token, a));
    let mb = bounty_pda(&mallory.pubkey(), 1);
    let ft = w.funder_token;
    // before expiry nobody takes either escrow, the funder included
    rejects(w.refund_to(&b, &mallory_token), "ConstraintTokenOwner");
    rejects(w.refund_to(&b, &ft), "NotExpired");
    // opening from somebody else's token account
    let a = w.open_args(2, 5 * ONE, 1_000);
    rejects(w.open_as(&mallory, &ft, a), "ConstraintTokenOwner");
    // after expiry each escrow returns to its own funder, exactly
    warp(&mut w.e.svm, TTL + GRACE as i64 + 1);
    rejects(w.refund_to(&b, &mallory_token), "ConstraintTokenOwner");
    let refund = |r: lb::accounts::Refund| Instruction { program_id: lb::ID, accounts: r.to_account_metas(None), data: lb::instruction::Refund {}.data() };
    // her own bounty with the other vault in its place
    let mut r = w.refund_accounts(&mb, &mallory_token);
    r.vault = vault_of(&b);
    rejects(send(&mut w.e.svm, &mallory, &[], vec![refund(r)]), "ConstraintSeeds");
    // the other bounty named with herself as its funder
    let mut r = w.refund_accounts(&b, &mallory_token);
    r.funder = mallory.pubkey();
    rejects(send(&mut w.e.svm, &mallory, &[], vec![refund(r)]), "ConstraintHasOne");
    assert_eq!((w.bal(&vault_of(&b)), w.bal(&vault_of(&mb))), (40 * ONE, 5 * ONE));
    ok(w.refund_to(&mb, &mallory_token));
    ok(w.refund_to(&b, &ft));
    assert_eq!((w.bal(&ft), w.bal(&mallory_token)), (1_000 * ONE, 100 * ONE));
}

#[test]
fn a_posted_reward_cannot_be_taken_back_before_it_expires() {
    let mut w = world();
    w.post(1);
    let b = w.open(1, 10 * ONE);
    let (f, ft) = (w.funder.insecure_clone(), w.funder_token);
    let held = |w: &World| assert_eq!((w.bounty(&b).status, w.bal(&vault_of(&b)), w.bal(&ft)), (lb::STATUS_OPEN, 10 * ONE, 990 * ONE));
    // at once, with no epoch posted since the open: the program has no cancel, and the refund waits
    rejects(w.old_cancel_as(&b, &f, &ft), "InstructionFallbackNotFound");
    rejects(w.refund_to(&b, &ft), "NotExpired");
    held(&w);
    // past the deadline but inside the grace, and at the refund time to the second
    warp(&mut w.e.svm, TTL + 1);
    rejects(w.refund_to(&b, &ft), "NotExpired");
    let wait = w.bounty(&b).refund_after - now(&w.e.svm);
    warp(&mut w.e.svm, wait);
    rejects(w.refund_to(&b, &ft), "NotExpired");
    rejects(w.old_cancel_as(&b, &f, &ft), "InstructionFallbackNotFound");
    held(&w);
    // one second later the reward returns, also while the program is paused
    let mut s = settings();
    s.paused = true;
    w.set(s);
    warp(&mut w.e.svm, 1);
    rejects(w.old_cancel_as(&b, &f, &ft), "InstructionFallbackNotFound");
    ok(w.refund_to(&b, &ft));
    assert_eq!((w.bounty(&b).status, w.bal(&ft)), (lb::STATUS_REFUNDED, 1_000 * ONE));
    assert!(w.gone(&vault_of(&b)));
}

#[test]
fn the_open_checks_amount_deadline_and_id() {
    let mut w = world();
    let (f, ft) = (w.funder.insecure_clone(), w.funder_token);
    let a = w.open_args(1, ONE - 1, 1_000);
    rejects(w.open_as(&f, &ft, a), "InvalidArgs");
    let mut a = w.open_args(1, ONE, 1_000);
    a.deadline = now(&w.e.svm) + 3_599;
    rejects(w.open_as(&f, &ft, a), "BountyTtl");
    let mut a = w.open_args(1, ONE, 1_000);
    a.deadline = now(&w.e.svm) + 30 * 86_400 + 1;
    rejects(w.open_as(&f, &ft, a), "BountyTtl");
    let a = w.open_args(1, 2_000 * ONE, 1_000);
    assert!(w.open_as(&f, &ft, a).is_err()); // more than the wallet holds
    let a = w.open_args(1, ONE, 1_000);
    ok(w.open_as(&f, &ft, a));
    // no epoch posted yet: every epoch qualifies
    assert_eq!(w.bounty(&bounty_pda(&f.pubkey(), 1)).min_epoch, 0);
    let a = w.open_args(1, ONE, 1_000);
    rejects(w.open_as(&f, &ft, a), "already in use");
    let c: lb::Config = read(&w.e.svm, &bconfig());
    assert_eq!(c.opened, 1);
}

#[test]
fn tokens_sent_into_an_escrow_follow_it() {
    let mut w = world();
    w.post(1);
    let b = w.open(1, 20 * ONE);
    let b2 = w.open(2, 20 * ONE);
    let (v, v2) = (vault_of(&b), vault_of(&b2));
    w.e.fund(&v, 3 * ONE);
    w.e.fund(&v2, 3 * ONE);
    w.post(2);
    ok(w.claim(&b, "r3"));
    warp(&mut w.e.svm, CONTEST as i64);
    let s0 = w.bal(&w.s.compute_vault);
    ok(w.pay(&b));
    assert_eq!(w.bal(&w.s.compute_vault), s0 + 23 * ONE);
    warp(&mut w.e.svm, TTL + GRACE as i64);
    let ft = w.funder_token;
    ok(w.refund_to(&b2, &ft));
    assert_eq!(w.bal(&ft), 983 * ONE);
    assert!(w.gone(&v) && w.gone(&v2));
}

#[test]
fn admin_powers_are_settings_pause_fees_and_handover_and_never_an_escrow() {
    let mut w = world();
    let admin = w.e.admin.insecure_clone();
    let stranger = funded(&mut w.e.svm);
    rejects(send(&mut w.e.svm, &stranger, &[], vec![set_settings_ix(&stranger.pubkey(), settings())]), "Unauthorized");
    let mut bad = settings();
    bad.min_ttl_s = bad.max_ttl_s + 1;
    rejects(send(&mut w.e.svm, &admin, &[], vec![set_settings_ix(&admin.pubkey(), bad)]), "InvalidArgs");
    let mut bad = settings();
    bad.min_amount = 0;
    rejects(send(&mut w.e.svm, &admin, &[], vec![set_settings_ix(&admin.pubkey(), bad)]), "InvalidArgs");

    w.post(1);
    // bounty 1 opens under no fee, 30 minutes of contest and 2 hours of grace
    let b1 = w.open(1, 100 * ONE);
    // the admin then sets a 50% fee, a year of contest time and no grace
    let mut s = settings();
    s.fee_bps = 5_000;
    s.contest_s = 365 * 86_400;
    s.refund_grace_s = 0;
    w.set(s);
    let x = w.bounty(&b1);
    assert_eq!((x.fee_bps, x.contest_s, x.refund_after), (0, CONTEST, NOW + TTL + GRACE as i64));
    // ... and a fee of 2.5% for bounty 2
    let mut s = settings();
    s.fee_bps = 250;
    w.set(s);
    let b2 = w.open(2, 100 * ONE);
    w.post(2);
    ok(w.claim(&b1, "r3"));
    ok(w.claim(&b2, "r3"));

    // pause: no open, no claim, no payout; nothing else
    let mut s = settings();
    s.paused = true;
    w.set(s);
    let (f, ft) = (w.funder.insecure_clone(), w.funder_token);
    let a = w.open_args(3, ONE, 1_000);
    rejects(w.open_as(&f, &ft, a), "Paused");
    rejects(w.claim(&b1, "r2"), "Paused");
    warp(&mut w.e.svm, CONTEST as i64);
    rejects(w.pay(&b1), "Paused");
    w.set(settings());

    let s0 = w.bal(&w.s.compute_vault);
    ok(w.pay(&b1));
    assert_eq!((w.bal(&w.s.compute_vault), w.bal(&fee_vault())), (s0 + 100 * ONE, 0));
    ok(w.pay(&b2));
    assert_eq!((w.bal(&w.s.compute_vault), w.bal(&fee_vault())), (s0 + 100 * ONE + 97_500_000, 2_500_000));
    assert_eq!((w.bounty(&b2).paid, w.bounty(&b2).fee_paid), (97_500_000, 2_500_000));

    // fees: the admin withdraws them; nobody else does, and the instruction reaches no escrow
    let b3 = w.open(3, 10 * ONE);
    let (_, to) = w.e.wallet(0);
    let wd = |signer: &Pubkey, from: Pubkey, amount: u64, e: &Env| Instruction {
        program_id: lb::ID,
        accounts: lb::accounts::WithdrawFees { config: bconfig(), admin: *signer, authority: bauthority(), fee_vault: from, to, mint: e.line_mint,
            token_program: e.line_program }.to_account_metas(None),
        data: lb::instruction::WithdrawFees { amount }.data(),
    };
    let ix = wd(&stranger.pubkey(), fee_vault(), 1, &w.e);
    rejects(send(&mut w.e.svm, &stranger, &[], vec![ix]), "Unauthorized");
    let ix = wd(&admin.pubkey(), vault_of(&b3), 10 * ONE, &w.e);
    rejects(send(&mut w.e.svm, &admin, &[], vec![ix]), "ConstraintSeeds");
    let ix = wd(&admin.pubkey(), fee_vault(), 2_500_001, &w.e);
    assert!(send(&mut w.e.svm, &admin, &[], vec![ix]).is_err());
    let ix = wd(&admin.pubkey(), fee_vault(), 2_500_000, &w.e);
    ok(send(&mut w.e.svm, &admin, &[], vec![ix]));
    assert_eq!((w.bal(&to), w.bal(&fee_vault()), w.bal(&vault_of(&b3))), (2_500_000, 0, 10 * ONE));
    // the admin has no way to take back, refund early or redirect an escrow
    rejects(w.old_cancel_as(&b3, &admin, &ft), "InstructionFallbackNotFound");
    rejects(w.refund_to(&b3, &ft), "NotExpired");

    // a paused program still refunds at expiry
    let mut s = settings();
    s.paused = true;
    w.set(s);
    warp(&mut w.e.svm, TTL + GRACE as i64 + 1);
    ok(w.refund_to(&b3, &ft));
    w.set(settings());

    // handover: proposed by the admin, taken only by the proposed key
    let next = funded(&mut w.e.svm);
    let accept = |k: &Pubkey| Instruction { program_id: lb::ID, accounts: lb::accounts::AcceptAdmin { config: bconfig(), new_admin: *k }.to_account_metas(None),
        data: lb::instruction::AcceptAdmin {}.data() };
    rejects(send(&mut w.e.svm, &stranger, &[], vec![admin_ix(&stranger.pubkey(), lb::instruction::ProposeAdmin { new_admin: stranger.pubkey() }.data())]), "Unauthorized");
    rejects(send(&mut w.e.svm, &next, &[], vec![accept(&next.pubkey())]), "Unauthorized");
    ok(send(&mut w.e.svm, &admin, &[], vec![admin_ix(&admin.pubkey(), lb::instruction::ProposeAdmin { new_admin: next.pubkey() }.data())]));
    rejects(send(&mut w.e.svm, &stranger, &[], vec![accept(&stranger.pubkey())]), "Unauthorized");
    ok(send(&mut w.e.svm, &next, &[], vec![accept(&next.pubkey())]));
    rejects(send(&mut w.e.svm, &admin, &[], vec![set_settings_ix(&admin.pubkey(), settings())]), "Unauthorized");
    ok(send(&mut w.e.svm, &next, &[], vec![set_settings_ix(&next.pubkey(), settings())]));
    let c: lb::Config = read(&w.e.svm, &bconfig());
    assert_eq!((c.admin, c.pending_admin), (next.pubkey(), Pubkey::default()));
}

/// Instruction encodings and live account bytes for packages/chain (test/open-bounty.test.ts).
/// `UPDATE_VECTORS=1 cargo test -p units-onchain-tests --test open_bounty vectors` rewrites the file.
#[test]
fn client_vectors_for_units_bounty() {
    let k = |b: u8| Pubkey::new_from_array([b; 32]);
    let (funder, mint, tp, author, admin) = (k(1), k(2), T22, k(4), k(5));
    let hexs = |b: &[u8]| b.iter().map(|x| format!("{x:02x}")).collect::<String>();
    let ix_json = |name: &str, ix: Instruction| serde_json::json!({ "name": name, "data": hexs(&ix.data),
        "accounts": ix.accounts.iter().map(|m| serde_json::json!([m.pubkey.to_string(), m.is_signer, m.is_writable])).collect::<Vec<_>>() });
    let s = lb::Settings { min_amount: 1_234_567, min_ttl_s: 60, max_ttl_s: 86_400, refund_grace_s: 7_200, contest_s: 1_800, fee_bps: 250, paused: true };
    let b = bounty_pda(&funder, 7);
    let funder_token = ata(&funder, &mint, &tp);
    let open = lb::OpenArgs { bounty_id: 7, amount: 5_000_000, terms_digest: [0x11; 32], lineage_id: [0x22; 32], target_digest: [0x33; 32], min_improvement_bps: 1_000,
        deadline: 1_900_086_400 };
    let claim = lb::ClaimArgs { epoch: 9, gen_id: [0x44; 32], height: 12, improvement_bps: 1_500, accepted_at: 1_900_000_100, author, target: vec!["t1".into(), "t2".into()],
        target_is_list: true, proof: vec![[0x55; 32], [0x66; 32]] };
    let refund = lb::accounts::Refund { config: bconfig(), bounty: b, vault: vault_of(&b), authority: bauthority(), funder, funder_token, mint, token_program: tp };
    let ixs = vec![
        ix_json("initialize", init_ix((mint, tp), &admin, &admin, s)),
        ix_json("set_settings", set_settings_ix(&admin, s)),
        ix_json("propose_admin", admin_ix(&admin, lb::instruction::ProposeAdmin { new_admin: funder }.data())),
        ix_json("accept_admin", Instruction { program_id: lb::ID, accounts: lb::accounts::AcceptAdmin { config: bconfig(), new_admin: funder }.to_account_metas(None),
            data: lb::instruction::AcceptAdmin {}.data() }),
        ix_json("withdraw_fees", Instruction { program_id: lb::ID, accounts: lb::accounts::WithdrawFees { config: bconfig(), admin, authority: bauthority(),
            fee_vault: fee_vault(), to: funder_token, mint, token_program: tp }.to_account_metas(None), data: lb::instruction::WithdrawFees { amount: 99 }.data() }),
        ix_json("open", Instruction { program_id: lb::ID, accounts: lb::accounts::OpenBounty { config: bconfig(), registry_config: registry_config(), funder, funder_token,
            bounty: b, vault: vault_of(&b), authority: bauthority(), mint, token_program: tp, system_program: system_program::ID }.to_account_metas(None),
            data: lb::instruction::OpenBounty { args: open }.data() }),
        ix_json("claim", Instruction { program_id: lb::ID, accounts: lb::accounts::Claim { config: bconfig(), bounty: b, registry_epoch: epoch_pda(9),
            challenge_config: challenge_config(), challenge_gate: challenge_gate(9), winner_compute: compute_vault(&author) }.to_account_metas(None),
            data: lb::instruction::Claim { args: claim }.data() }),
        ix_json("pay", Instruction { program_id: lb::ID, accounts: lb::accounts::Pay { config: bconfig(), bounty: b, vault: vault_of(&b), authority: bauthority(), funder,
            winner_compute: compute_vault(&author), fee_vault: fee_vault(), mint, token_program: tp }.to_account_metas(None), data: lb::instruction::Pay {}.data() }),
        ix_json("refund", Instruction { program_id: lb::ID, accounts: refund.to_account_metas(None), data: lb::instruction::Refund {}.data() }),
    ];
    // live account bytes after a claim, with the fields the program itself reads back
    let mut w = world();
    w.post(1);
    let bp = w.open(1, 50 * ONE);
    w.post(2);
    ok(w.claim(&bp, "r3"));
    let (c, x): (lb::Config, lb::Bounty) = (read(&w.e.svm, &bconfig()), w.bounty(&bp));
    let doc = serde_json::json!({
        "_note": "Generated by onchain/tests/tests/open_bounty.rs (UPDATE_VECTORS=1); do not edit.",
        "program": lb::ID.to_string(),
        "keys": { "funder": funder.to_string(), "mint": mint.to_string(), "token_program": tp.to_string(), "author": author.to_string(), "admin": admin.to_string() },
        "instructions": ixs,
        "config": { "bytes": hexs(&w.e.svm.get_account(&bconfig()).unwrap().data), "admin": c.admin.to_string(), "mint": c.mint.to_string(),
            "token_program": c.token_program.to_string(), "launch_program": c.launch_program.to_string(), "min_amount": c.settings.min_amount.to_string(),
            "min_ttl_s": c.settings.min_ttl_s, "max_ttl_s": c.settings.max_ttl_s, "refund_grace_s": c.settings.refund_grace_s, "contest_s": c.settings.contest_s,
            "fee_bps": c.settings.fee_bps, "paused": c.settings.paused, "opened": c.opened.to_string() },
        "bounty": { "bytes": hexs(&w.e.svm.get_account(&bp).unwrap().data), "funder": x.funder.to_string(), "bounty_id": x.bounty_id.to_string(),
            "amount": x.amount.to_string(), "fee_bps": x.fee_bps, "terms_digest": hexs(&x.terms_digest), "lineage_id": hexs(&x.lineage_id),
            "target_digest": hexs(&x.target_digest), "min_improvement_bps": x.min_improvement_bps, "min_epoch": x.min_epoch.to_string(),
            "deadline": x.deadline.to_string(), "created_at": x.created_at.to_string(), "refund_after": x.refund_after.to_string(), "contest_s": x.contest_s,
            "status": x.status, "winner": x.winner.to_string(), "win_height": x.win_height.to_string(), "win_epoch": x.win_epoch.to_string(),
            "win_gen_id": hexs(&x.win_gen_id), "win_improvement_bps": x.win_improvement_bps.to_string(), "win_leaf": hexs(&x.win_leaf),
            "claimed_at": x.claimed_at.to_string(), "contest_until": x.contest_until.to_string() },
    });
    let path = manifest("fixtures/open-bounty-vectors.json");
    if std::env::var("UPDATE_VECTORS").is_ok() {
        std::fs::write(&path, serde_json::to_string_pretty(&doc).unwrap() + "\n").unwrap();
    }
    let have: Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("run with UPDATE_VECTORS=1 once")).unwrap();
    // the instruction encodings are fixed; the account bytes hold this run's random keys
    assert_eq!(have["instructions"], doc["instructions"], "instruction encodings changed: rerun with UPDATE_VECTORS=1 and update packages/chain");
    assert_eq!(have["program"], doc["program"]);
}
