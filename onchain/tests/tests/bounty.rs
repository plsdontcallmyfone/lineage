//! Bounties (plan C6, SPEC 14.7): escrow from a compute vault, released only into the compute vault
//! of an agent credited in an accepted generation, proven by Core's contribution leaf against the
//! registry's `Epoch.record_root`. Leaves, roots and proofs come from `make-fixtures.ts`, built with
//! packages/core records.ts `contributionLeaf`, so a Core-built record root is proven to release here.
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::solana_program::system_program;
use anchor_lang::{InstructionData, ToAccountMetas};
use lineage_onchain_tests::*;
use ll::bounty as bt;
use litesvm::types::TransactionResult;
use serde_json::Value;

const TTL: i64 = 3 * 86_400;
const GRACE: u32 = 3_600;

fn bcfg() -> Pubkey {
    lpda(&[bt::BOUNTY_CONFIG_SEED])
}
fn bounty_pda(payer: &Pubkey, id: u64) -> Pubkey {
    lpda(&[bt::BOUNTY_SEED, payer.as_ref(), &id.to_le_bytes()])
}
fn bounty_vault(b: &Pubkey) -> Pubkey {
    lpda(&[bt::BOUNTY_VAULT_SEED, b.as_ref()])
}
fn ledger(agent: &Pubkey) -> Pubkey {
    lpda(&[bt::BOUNTY_LEDGER_SEED, agent.as_ref()])
}
fn receipt(payer: &Pubkey, leaf: &[u8; 32]) -> Pubkey {
    lpda(&[bt::BOUNTY_RECEIPT_SEED, payer.as_ref(), leaf])
}

fn config_args() -> bt::BountyConfigArgs {
    bt::BountyConfigArgs { max_bounty_out_bps: 2_000, self_hosted_in_cap: 50 * ONE, window_s: 86_400, min_ttl_s: 3_600, max_ttl_s: 30 * 86_400,
        refund_grace_s: GRACE, min_amount: ONE, paused: false }
}
fn set_config_ix(admin: &Pubkey, args: bt::BountyConfigArgs) -> Instruction {
    Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::SetBountyConfig { launch_config: launch_config(), bounty_config: bcfg(), admin: *admin, system_program: system_program::ID }
            .to_account_metas(None),
        data: ll::instruction::SetBountyConfig { args }.data(),
    }
}

struct World {
    e: Env,
    fx: Value,
    /// Hosted payer P (runtime opens for it), self-hosted payee S, hosted payee H, an unrelated launched agent.
    p: Launched,
    s: Launched,
    h: Launched,
}

fn hex(v: &Value) -> [u8; 32] {
    hex32(v.as_str().unwrap())
}
fn fx_key(fx: &Value, name: &str) -> Pubkey {
    b58_pubkey(fx["bounty"]["keys"][name].as_str().unwrap())
}

fn world() -> World {
    let mut e = setup(LineKind::Pump);
    let fx = fixtures();
    let mut args = default_launch_args();
    let p = e.launch_agent(seeded(31), args.clone());
    args.hosted = false;
    args.symbol = "SELF".into();
    let s = e.launch_agent(seeded(32), args.clone());
    args.hosted = true;
    args.symbol = "HOST".into();
    let h = e.launch_agent(seeded(33), args);
    for (l, k) in [(&p, "P"), (&s, "S"), (&h, "H")] {
        assert_eq!(l.agent.pubkey(), fx_key(&fx, k));
    }
    let cv = p.compute_vault;
    e.fund(&cv, 100 * ONE);
    let admin = e.admin.insecure_clone();
    ok(send(&mut e.svm, &admin, &[], vec![set_config_ix(&admin.pubkey(), config_args())]));
    World { e, fx, p, s, h }
}

impl World {
    fn post(&mut self, epoch: u64) {
        let root = hex(&self.fx["bounty"]["roots"][epoch.to_string()]);
        let core = self.e.core.insecure_clone();
        let ix = self.e.post_epoch_ix(&core.pubkey(), lr::PostEpochArgs { epoch, payout_root: [0; 32], lineage_root: [0; 32], total_units_micro: 0,
            pool_amount: 0, rebate_amount: 0, record_root: root });
        ok(send(&mut self.e.svm, &core, &[], vec![ix]));
    }
    fn open_ix(&self, opener: &Pubkey, payer: &Launched, a: bt::OpenBountyArgs) -> Instruction {
        let b = bounty_pda(&payer.agent.pubkey(), a.bounty_id);
        Instruction {
            program_id: ll::ID,
            accounts: ll::accounts::OpenBounty {
                launch_config: launch_config(), bounty_config: bcfg(), registry_config: registry_config(), opener: *opener, authority: launch_authority(),
                payer_launch: payer.launch, payer_compute: payer.compute_vault, payer_ledger: ledger(&payer.agent.pubkey()), bounty: b,
                bounty_vault: bounty_vault(&b), line_mint: self.e.line_mint, line_token_program: self.e.line_program, system_program: system_program::ID,
                payer_record: agent_record(&payer.agent.pubkey()),
            }.to_account_metas(None),
            data: ll::instruction::OpenBounty { args: a }.data(),
        }
    }
    fn args(&self, id: u64, payee: Pubkey, amount: u64, kind: u8, value: [u8; 32]) -> bt::OpenBountyArgs {
        bt::OpenBountyArgs { bounty_id: id, payee, amount, terms_digest: [id as u8; 32], condition_kind: kind, lineage_id: hex(&self.fx["bounty"]["lineage"]),
            condition_value: value, deadline: now(&self.e.svm) + TTL }
    }
    /// The runtime authority opens for the hosted payer P.
    fn open(&mut self, a: bt::OpenBountyArgs) -> TransactionResult {
        let rt = self.e.runtime.insecure_clone();
        let ix = self.open_ix(&rt.pubkey(), &self.p, a);
        send(&mut self.e.svm, &rt, &[], vec![ix])
    }
    fn commitment(&self, c: &str) -> [u8; 32] {
        hex(&self.fx["bounty"]["contributions"][c]["candidate_commitment"])
    }
    /// Release args straight from a fixture contribution.
    fn release_args(&self, c: &str) -> bt::ReleaseArgs {
        let x = &self.fx["bounty"]["contributions"][c];
        let roles = |r: &str| bt::ROLES.iter().position(|x| *x == r).unwrap() as u8;
        let (target, is_list) = match &x["target"] {
            Value::String(s) => (vec![s.clone()], false),
            Value::Array(a) => (a.iter().map(|v| v.as_str().unwrap().to_string()).collect(), true),
            _ => unreachable!(),
        };
        bt::ReleaseArgs {
            leaf: hex(&x["leaf"]),
            epoch: x["epoch"].as_u64().unwrap(),
            gen_id: hex(&x["gen_id"]),
            lineage_id: hex(&x["lineage_id"]),
            candidate_commitment: hex(&x["candidate_commitment"]),
            target,
            target_is_list: is_list,
            members: x["members"].as_array().unwrap().iter().map(|m| bt::MemberArg {
                agent: b58_pubkey(m["agent"].as_str().unwrap()), role: roles(m["role"].as_str().unwrap()), share_bps: m["share_bps"].as_u64().unwrap() as u16,
            }).collect(),
            finder: x["finder"].as_str().map(b58_pubkey),
            proof: x["proof"].as_array().unwrap().iter().map(hex).collect(),
        }
    }
    fn release_ix_with(&self, caller: &Pubkey, payer: &Pubkey, id: u64, payee: &Launched, a: bt::ReleaseArgs, epoch_acct: Pubkey) -> Instruction {
        let b = bounty_pda(payer, id);
        let opener = self.e.svm.get_account(&b).map(|_| read::<bt::Bounty>(&self.e.svm, &b).opener).unwrap_or_default();
        Instruction {
            program_id: ll::ID,
            accounts: ll::accounts::ReleaseBounty {
                launch_config: launch_config(), bounty_config: bcfg(), caller: *caller, authority: launch_authority(), bounty: b, bounty_vault: bounty_vault(&b),
                opener, registry_epoch: epoch_acct, payee_launch: payee.launch, payee_compute: payee.compute_vault, payee_ledger: ledger(&payee.agent.pubkey()),
                receipt: receipt(payer, &a.leaf), line_mint: self.e.line_mint, line_token_program: self.e.line_program, system_program: system_program::ID,
                challenge_config: challenge_config(), challenge_gate: challenge_gate(a.epoch),
            }.to_account_metas(None),
            data: ll::instruction::ReleaseBounty { args: a }.data(),
        }
    }
    fn release_with(&mut self, id: u64, payee: &str, a: bt::ReleaseArgs) -> TransactionResult {
        let caller = funded(&mut self.e.svm);
        let payee = match payee { "S" => &self.s, "H" => &self.h, _ => &self.p };
        let ix = self.release_ix_with(&caller.pubkey(), &self.p.agent.pubkey(), id, payee, a.clone(), epoch_pda(a.epoch));
        send(&mut self.e.svm, &caller, &[], vec![cu(400_000), ix])
    }
    fn release(&mut self, id: u64, payee: &str, c: &str) -> TransactionResult {
        let a = self.release_args(c);
        self.release_with(id, payee, a)
    }
    fn refund_accounts(&self, id: u64) -> ll::accounts::RefundBounty {
        let b = bounty_pda(&self.p.agent.pubkey(), id);
        ll::accounts::RefundBounty {
            launch_config: launch_config(), bounty_config: bcfg(), authority: launch_authority(), bounty: b, bounty_vault: bounty_vault(&b),
            opener: read::<bt::Bounty>(&self.e.svm, &b).opener, payer_launch: self.p.launch, payer_compute: self.p.compute_vault,
            line_mint: self.e.line_mint, line_token_program: self.e.line_program,
        }
    }
    fn refund(&mut self, id: u64) -> TransactionResult {
        let k = funded(&mut self.e.svm);
        let ix = Instruction { program_id: ll::ID, accounts: self.refund_accounts(id).to_account_metas(None), data: ll::instruction::RefundBounty {}.data() };
        send(&mut self.e.svm, &k, &[], vec![ix])
    }
    fn cancel(&mut self, id: u64, signer: &Keypair) -> TransactionResult {
        let accounts = ll::accounts::CancelBounty { r: self.refund_accounts(id), registry_config: registry_config(), signer: signer.pubkey(),
            payer_record: agent_record(&self.p.agent.pubkey()) };
        let ix = Instruction { program_id: ll::ID, accounts: accounts.to_account_metas(None), data: ll::instruction::CancelBounty {}.data() };
        send(&mut self.e.svm, signer, &[], vec![ix])
    }
    fn bounty(&self, id: u64) -> bt::Bounty {
        read(&self.e.svm, &bounty_pda(&self.p.agent.pubkey(), id))
    }
}

#[test]
fn rust_contribution_leaf_matches_core() {
    let fx = fixtures();
    let w_args = |c: &Value| {
        let (t, l) = match &c["target"] {
            Value::String(s) => (vec![s.clone()], false),
            Value::Array(a) => (a.iter().map(|v| v.as_str().unwrap().to_string()).collect::<Vec<_>>(), true),
            _ => unreachable!(),
        };
        let tj = bt::target_json(&t, l).unwrap();
        let members: Vec<bt::MemberArg> = c["members"].as_array().unwrap().iter().map(|m| bt::MemberArg {
            agent: b58_pubkey(m["agent"].as_str().unwrap()),
            role: bt::ROLES.iter().position(|x| *x == m["role"].as_str().unwrap()).unwrap() as u8,
            share_bps: m["share_bps"].as_u64().unwrap() as u16,
        }).collect();
        let finder = c["finder"].as_str().map(b58_pubkey);
        (tj, members, finder)
    };
    let mut n = 0;
    for (_, c) in fx["bounty"]["contributions"].as_object().unwrap() {
        let (tj, members, finder) = w_args(c);
        let json = bt::contribution_json(c["epoch"].as_u64().unwrap(), &hex(&c["gen_id"]), &hex(&c["lineage_id"]), &tj, &hex(&c["candidate_commitment"]),
            &members, finder.as_ref()).unwrap();
        assert_eq!(String::from_utf8(json).unwrap(), c["json"].as_str().unwrap());
        let leaf = bt::contribution_leaf(c["epoch"].as_u64().unwrap(), &hex(&c["gen_id"]), &hex(&c["lineage_id"]), &tj, &hex(&c["candidate_commitment"]),
            &members, finder.as_ref()).unwrap();
        assert_eq!(leaf, hex(&c["leaf"]));
        n += 1;
    }
    assert_eq!(n, 6);
    assert_eq!(bt::target_digest(b"\"ir\""), hex(&fx["bounty"]["target_ir_digest"]));
}

#[test]
fn config_is_admin_only_and_validated() {
    let mut w = world();
    let stranger = funded(&mut w.e.svm);
    rejects(send(&mut w.e.svm, &stranger, &[], vec![set_config_ix(&stranger.pubkey(), config_args())]), "Unauthorized");
    let admin = w.e.admin.insecure_clone();
    let mut bad = config_args();
    bad.max_bounty_out_bps = 10_001;
    rejects(send(&mut w.e.svm, &admin, &[], vec![set_config_ix(&admin.pubkey(), bad)]), "InvalidArgs");
    let mut bad = config_args();
    bad.min_ttl_s = bad.max_ttl_s + 1;
    rejects(send(&mut w.e.svm, &admin, &[], vec![set_config_ix(&admin.pubkey(), bad)]), "InvalidArgs");
    let mut c = config_args();
    c.max_bounty_out_bps = 5_000;
    ok(send(&mut w.e.svm, &admin, &[], vec![set_config_ix(&admin.pubkey(), c)]));
    let got: bt::BountyConfig = read(&w.e.svm, &bcfg());
    assert_eq!((got.max_bounty_out_bps, got.self_hosted_in_cap, got.refund_grace_s), (5_000, 50 * ONE, GRACE));
}

#[test]
fn release_with_a_core_proof_pays_the_payee_compute_vault_once() {
    let mut w = world();
    w.post(1);
    let hk = w.h.agent.pubkey();
    let k2 = w.commitment("c2");
    let a = w.args(1, hk, 10 * ONE, bt::COND_COMMITMENT, k2);
    let rt = w.e.runtime.pubkey();
    let rt_before = w.e.svm.get_account(&rt).unwrap().lamports;
    ok(w.open(a));
    let b = w.bounty(1);
    assert_eq!((b.status, b.min_epoch, b.amount, b.payee, b.opener), (bt::STATUS_OPEN, 2, 10 * ONE, hk, rt));
    assert_eq!(balance(&w.e.svm, &w.p.compute_vault), 90 * ONE);
    assert_eq!(balance(&w.e.svm, &bounty_vault(&bounty_pda(&w.p.agent.pubkey(), 1))), 10 * ONE);
    // Nothing to release against before the epoch that holds the generation is posted.
    rejects(w.release(1, "H", "c2"), "AccountNotInitialized");
    w.post(2);
    let h_before = balance(&w.e.svm, &w.h.compute_vault);
    ok(w.release(1, "H", "c2"));
    assert_eq!(balance(&w.e.svm, &w.h.compute_vault), h_before + 10 * ONE);
    assert!(w.e.svm.get_account(&bounty_vault(&bounty_pda(&w.p.agent.pubkey(), 1))).map_or(true, |a| a.lamports == 0));
    let b = w.bounty(1);
    assert_eq!((b.status, b.released_to, b.released_epoch, b.leaf), (bt::STATUS_RELEASED, hk, 2, hex(&w.fx["bounty"]["contributions"]["c2"]["leaf"])));
    // The opener paid bounty + vault + ledger rent and got the vault rent back.
    let rt_after = w.e.svm.get_account(&rt).unwrap().lamports;
    assert!(rt_before - rt_after < 10_000_000);
    let led: bt::BountyLedger = read(&w.e.svm, &ledger(&hk));
    assert_eq!(led.received_total, 10 * ONE);
    // Double release, and a refund after release: refused (the escrow vault is closed).
    rejects(w.release(1, "H", "c2"), "AccountNotInitialized");
    warp(&mut w.e.svm, TTL + GRACE as i64 + 1);
    rejects(w.refund(1), "AccountNotInitialized");
}

#[test]
fn wrong_payee_and_wrong_condition_are_refused() {
    let mut w = world();
    w.post(1);
    let (hk, sk) = (w.h.agent.pubkey(), w.s.agent.pubkey());
    let k2 = w.commitment("c2");
    ok(w.open(w.args(1, hk, 5 * ONE, bt::COND_COMMITMENT, k2)));
    // Open bounty on any accepted "ir" generation of lineage L.
    let ir = hex(&w.fx["bounty"]["target_ir_digest"]);
    ok(w.open(w.args(2, Pubkey::default(), 5 * ONE, bt::COND_TARGET, ir)));
    w.post(2);
    // Wrong payee: S is not credited in c2 (named payee H).
    rejects(w.release(1, "S", "c2"), "BountyPayee");
    // Payee named in the bounty but the payer itself in the slot is refused too.
    rejects(w.release(1, "P", "c2"), "BountyPayee");
    // Wrong condition: c5 is another commitment.
    rejects(w.release(1, "H", "c5"), "BountyCondition");
    // Open bounty: target list (c3) and another lineage (c4) do not meet it.
    rejects(w.release(2, "S", "c3"), "BountyCondition");
    rejects(w.release(2, "H", "c4"), "BountyCondition");
    // An open bounty pays only an author: H is the author of c2, so a reviewer could not take it;
    // S is no member of c2 at all.
    rejects(w.release(2, "S", "c2"), "BountyPayee");
    // Forged leaf fields (shares changed): the leaf no longer matches.
    let mut a = w.release_args("c5");
    a.members[0].share_bps = 9_999;
    rejects(w.release_with(2, "S", a), "BadProof");
    // A leaf naming a different payee than the members it proves.
    let mut a = w.release_args("c5");
    a.members[0].agent = hk;
    rejects(w.release_with(2, "H", a), "BadProof");
    // The right ones.
    ok(w.release(1, "H", "c2"));
    ok(w.release(2, "S", "c5"));
    assert_eq!(w.bounty(2).released_to, sk);
}

#[test]
fn proof_reuse_and_stale_generations_are_refused() {
    let mut w = world();
    w.post(1);
    let hk = w.h.agent.pubkey();
    let k1 = w.commitment("c1");
    let k2 = w.commitment("c2");
    // Two bounties of the same payer on the same generation: the leaf releases one of them.
    ok(w.open(w.args(1, hk, 5 * ONE, bt::COND_COMMITMENT, k2)));
    ok(w.open(w.args(2, hk, 5 * ONE, bt::COND_COMMITMENT, k2)));
    // A generation accepted before the bounty opened (epoch 1 < min_epoch 2) does not qualify.
    ok(w.open(w.args(3, Pubkey::default(), 5 * ONE, bt::COND_COMMITMENT, k1)));
    w.post(2);
    rejects(w.release(3, "S", "c1"), "BountyCondition");
    ok(w.release(1, "H", "c2"));
    rejects(w.release(2, "H", "c2"), "already in use");
    assert_eq!(w.bounty(2).status, bt::STATUS_OPEN);
}

#[test]
fn forged_record_roots_are_refused() {
    let mut w = world();
    w.post(1);
    let hk = w.h.agent.pubkey();
    let k2 = w.commitment("c2");
    ok(w.open(w.args(1, hk, 5 * ONE, bt::COND_COMMITMENT, k2)));
    // The attacker's own tree: a leaf for c2 alone is its own root.
    let leaf = hex(&w.fx["bounty"]["contributions"]["c2"]["leaf"]);
    let real2 = {
        w.post(2);
        w.e.svm.get_account(&epoch_pda(2)).unwrap()
    };
    let mut forged = real2.clone();
    let rr = forged.data.len() - 32;
    forged.data[rr..].copy_from_slice(&leaf);
    let mut a = w.release_args("c2");
    a.proof = vec![];
    // (1) a registry-owned Epoch with the forged root at another address: seeds refuse it.
    let fake = Pubkey::new_unique();
    w.e.svm.set_account(fake, forged.clone()).unwrap();
    let caller = funded(&mut w.e.svm);
    let ix = w.release_ix_with(&caller.pubkey(), &w.p.agent.pubkey(), 1, &w.h, a.clone(), fake);
    rejects(send(&mut w.e.svm, &caller, &[], vec![cu(400_000), ix]), "ConstraintSeeds");
    // (2) the forged data at the epoch's PDA but owned by another program: owner refused.
    let mut other = forged.clone();
    other.owner = ll::ID;
    let e3 = epoch_pda(3);
    w.e.svm.set_account(e3, other).unwrap();
    let mut a3 = a.clone();
    a3.epoch = 3;
    let ix = w.release_ix_with(&caller.pubkey(), &w.p.agent.pubkey(), 1, &w.h, a3, e3);
    rejects(send(&mut w.e.svm, &caller, &[], vec![cu(400_000), ix]), "AccountOwnedByWrongProgram");
    // (3) the real epoch 2 with the attacker's empty proof: BadProof.
    rejects(w.release_with(1, "H", a), "BadProof");
    ok(w.release(1, "H", "c2"));
}

#[test]
fn refund_only_after_deadline_and_grace_and_late_epochs_do_not_qualify() {
    let mut w = world();
    w.post(1);
    let hk = w.h.agent.pubkey();
    let k6 = w.commitment("c6");
    ok(w.open(w.args(1, hk, 7 * ONE, bt::COND_COMMITMENT, k6)));
    rejects(w.refund(1), "BountyNotExpired");
    w.post(2);
    warp(&mut w.e.svm, TTL);
    rejects(w.refund(1), "BountyNotExpired");
    warp(&mut w.e.svm, 10);
    // Epoch 3 lands after the deadline: its generation does not qualify.
    w.post(3);
    rejects(w.release(1, "H", "c6"), "BountyCondition");
    warp(&mut w.e.svm, GRACE as i64 - 20);
    rejects(w.refund(1), "BountyNotExpired");
    warp(&mut w.e.svm, 20);
    let before = balance(&w.e.svm, &w.p.compute_vault);
    ok(w.refund(1));
    assert_eq!(balance(&w.e.svm, &w.p.compute_vault), before + 7 * ONE);
    assert_eq!(w.bounty(1).status, bt::STATUS_REFUNDED);
    rejects(w.refund(1), "AccountNotInitialized");
    rejects(w.release(1, "H", "c6"), "AccountNotInitialized");
}

#[test]
fn caps_and_opener_rules() {
    let mut w = world();
    let hk = w.h.agent.pubkey();
    let ir = hex(&w.fx["bounty"]["target_ir_digest"]);
    // Hosted payer: only the runtime opens; the launcher cannot.
    let launcher = w.p.launcher.insecure_clone();
    let ix = w.open_ix(&launcher.pubkey(), &w.p, w.args(1, hk, ONE, bt::COND_TARGET, ir));
    rejects(send(&mut w.e.svm, &launcher, &[], vec![ix]), "Unauthorized");
    // Self-hosted payer: only its launcher; the runtime cannot.
    let cv = w.s.compute_vault;
    w.e.fund(&cv, 10 * ONE);
    let rt = w.e.runtime.insecure_clone();
    let ix = w.open_ix(&rt.pubkey(), &w.s, w.args(1, hk, ONE, bt::COND_TARGET, ir));
    rejects(send(&mut w.e.svm, &rt, &[], vec![ix]), "Unauthorized");
    let sl = w.s.launcher.insecure_clone();
    let ix = w.open_ix(&sl.pubkey(), &w.s, w.args(1, hk, ONE, bt::COND_TARGET, ir));
    ok(send(&mut w.e.svm, &sl, &[], vec![ix]));
    // TTL bounds and amounts.
    let mut a = w.args(1, hk, ONE, bt::COND_TARGET, ir);
    a.deadline = now(&w.e.svm) + 60;
    rejects(w.open(a), "BountyTtl");
    rejects(w.open(w.args(1, hk, ONE / 2, bt::COND_TARGET, ir)), "InvalidArgs");
    rejects(w.open(w.args(1, w.p.agent.pubkey(), ONE, bt::COND_TARGET, ir)), "InvalidArgs");
    // Cap: 20% of the 100 tLINE vault per window.
    ok(w.open(w.args(1, hk, 15 * ONE, bt::COND_TARGET, ir)));
    rejects(w.open(w.args(2, hk, 6 * ONE, bt::COND_TARGET, ir)), "BountyCap");
    ok(w.open(w.args(2, hk, 5 * ONE, bt::COND_TARGET, ir)));
    rejects(w.open(w.args(3, hk, ONE, bt::COND_TARGET, ir)), "BountyCap");
    warp(&mut w.e.svm, 86_400);
    ok(w.open(w.args(3, hk, ONE, bt::COND_TARGET, ir)));
    let led: bt::BountyLedger = read(&w.e.svm, &ledger(&w.p.agent.pubkey()));
    assert_eq!((led.out_base, led.out_amount, led.opened_total), (80 * ONE, ONE, 21 * ONE));
}

#[test]
fn self_hosted_payees_are_capped() {
    let mut w = world();
    let admin = w.e.admin.insecure_clone();
    let mut c = config_args();
    c.max_bounty_out_bps = 10_000;
    c.self_hosted_in_cap = 15 * ONE;
    ok(send(&mut w.e.svm, &admin, &[], vec![set_config_ix(&admin.pubkey(), c)]));
    let sk = w.s.agent.pubkey();
    let (k1, k3, k5) = (w.commitment("c1"), w.commitment("c3"), w.commitment("c5"));
    // Opened before any epoch: epoch 1's generation c1 qualifies (min_epoch 0).
    ok(w.open(w.args(3, sk, ONE, bt::COND_COMMITMENT, k1)));
    assert_eq!(w.bounty(3).min_epoch, 0);
    w.post(1);
    ok(w.open(w.args(1, sk, 10 * ONE, bt::COND_COMMITMENT, k3)));
    ok(w.open(w.args(2, sk, 10 * ONE, bt::COND_COMMITMENT, k5)));
    w.post(2);
    ok(w.release(1, "S", "c3"));
    rejects(w.release(2, "S", "c5"), "SelfHostedCap");
    warp(&mut w.e.svm, 86_400);
    ok(w.release(2, "S", "c5"));
    assert_eq!(balance(&w.e.svm, &w.s.compute_vault), 20 * ONE);
    // Cap 0: self-hosted payees are not paid at all.
    c.self_hosted_in_cap = 0;
    ok(send(&mut w.e.svm, &admin, &[], vec![set_config_ix(&admin.pubkey(), c)]));
    warp(&mut w.e.svm, 86_400);
    rejects(w.release(3, "S", "c1"), "SelfHostedCap");
    // A hosted payee is never capped by it.
    assert_eq!(w.bounty(3).status, bt::STATUS_OPEN);
}

#[test]
fn cancel_only_by_the_opener_before_the_next_epoch() {
    let mut w = world();
    w.post(1);
    let hk = w.h.agent.pubkey();
    let ir = hex(&w.fx["bounty"]["target_ir_digest"]);
    ok(w.open(w.args(1, hk, 4 * ONE, bt::COND_TARGET, ir)));
    ok(w.open(w.args(2, hk, 4 * ONE, bt::COND_TARGET, ir)));
    let stranger = funded(&mut w.e.svm);
    rejects(w.cancel(1, &stranger), "Unauthorized");
    let launcher = w.p.launcher.insecure_clone();
    rejects(w.cancel(1, &launcher), "Unauthorized");
    let rt = w.e.runtime.insecure_clone();
    let before = balance(&w.e.svm, &w.p.compute_vault);
    ok(w.cancel(1, &rt));
    assert_eq!(balance(&w.e.svm, &w.p.compute_vault), before + 4 * ONE);
    assert_eq!(w.bounty(1).status, bt::STATUS_CANCELLED);
    // Once the next epoch is posted the escrow is locked until release or expiry.
    w.post(2);
    rejects(w.cancel(2, &rt), "BountyLocked");
    ok(w.release(2, "H", "c2"));
}

// ---------- internal audit A1 (docs/AUDIT.md, "Onchain") ----------

/// A1-01: anyone could send one base unit of `$LINE` into an escrow vault. `drain` moved only
/// `bounty.amount` and then closed the vault, which the token program refuses on a nonzero balance,
/// so release, refund and cancel all failed and the escrow was frozen forever. The whole vault
/// balance now moves (a donation follows the escrow).
#[test]
fn audit_a1_01_a_donation_cannot_freeze_an_escrow() {
    let mut w = world();
    w.post(1);
    let (hk, k2) = (w.h.agent.pubkey(), w.commitment("c2"));
    let ir = hex(&w.fx["bounty"]["target_ir_digest"]);
    ok(w.open(w.args(1, hk, 5 * ONE, bt::COND_COMMITMENT, k2)));
    ok(w.open(w.args(2, Pubkey::default(), 5 * ONE, bt::COND_TARGET, ir)));
    ok(w.open(w.args(3, Pubkey::default(), 5 * ONE, bt::COND_TARGET, ir)));
    let (donor, donor_token) = w.e.wallet(10 * ONE);
    let m = w.e.line_mint;
    for id in [1u64, 2, 3] {
        let v = bounty_vault(&bounty_pda(&w.p.agent.pubkey(), id));
        transfer(&mut w.e.svm, &donor, &m, &donor_token, &v, 1);
    }
    // Cancel (before the next epoch) still lands and returns escrow and donation to the payer.
    let p0 = balance(&w.e.svm, &w.p.compute_vault);
    let rt = w.e.runtime.insecure_clone();
    ok(w.cancel(3, &rt));
    assert_eq!(balance(&w.e.svm, &w.p.compute_vault), p0 + 5 * ONE + 1);
    // Release still lands: the payee gets the escrow and the donation.
    w.post(2);
    let h0 = balance(&w.e.svm, &w.h.compute_vault);
    ok(w.release(1, "H", "c2"));
    assert_eq!(balance(&w.e.svm, &w.h.compute_vault), h0 + 5 * ONE + 1);
    // Refund still lands after the deadline plus grace.
    warp(&mut w.e.svm, TTL + GRACE as i64 + 1);
    let p1 = balance(&w.e.svm, &w.p.compute_vault);
    ok(w.refund(2));
    assert_eq!(balance(&w.e.svm, &w.p.compute_vault), p1 + 5 * ONE + 1);
    assert_eq!(w.bounty(2).status, bt::STATUS_REFUNDED);
}

fn withdraw_ix(w: &World, signer: &Pubkey, l: &Launched, to: &Pubkey, amount: u64) -> Instruction {
    Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::WithdrawCompute { launch_config: launch_config(), owner: *signer, authority: launch_authority(), agent_launch: l.launch,
            compute_vault: l.compute_vault, owner_token: *to, line_mint: w.e.line_mint, line_token_program: w.e.line_program,
            agent_record: agent_record(&l.agent.pubkey()) }.to_account_metas(None),
        data: ll::instruction::WithdrawCompute { amount }.data(),
    }
}

/// A1-03: after a public owner transfer (`propose_owner`, `accept_owner`) the seller kept every power
/// over a self-hosted agent's compute vault, because `withdraw_compute` and the bounty opener checked
/// `AgentLaunch.launcher`, fixed at launch. A seller could drain the vault (author rewards included)
/// right after the sale. Both now follow the registry `Agent.owner`.
#[test]
fn audit_a1_03_compute_follows_the_registry_owner() {
    let mut w = world();
    let s = w.s.agent.pubkey();
    let cv = w.s.compute_vault;
    w.e.fund(&cv, 100 * ONE);
    let seller = w.s.launcher.insecure_clone();
    let seller_line = w.s.launcher_line;
    let (buyer, buyer_line) = w.e.wallet(0);
    let ix = w.e.owner_agent_ix(&seller.pubkey(), &s, lr::instruction::ProposeOwner { new_owner: buyer.pubkey() }.data());
    ok(send(&mut w.e.svm, &seller, &[], vec![ix]));
    // Until the buyer accepts, the seller is still the owner.
    let ix = withdraw_ix(&w, &seller.pubkey(), &w.s, &seller_line, ONE);
    ok(send(&mut w.e.svm, &seller, &[], vec![ix]));
    let ix = w.e.accept_owner_ix(&buyer.pubkey(), &s);
    ok(send(&mut w.e.svm, &buyer, &[], vec![ix]));
    // The seller can no longer withdraw, open a bounty from the vault, or cancel one.
    let ix = withdraw_ix(&w, &seller.pubkey(), &w.s, &seller_line, ONE);
    rejects(send(&mut w.e.svm, &seller, &[], vec![ix]), "Unauthorized");
    let hk = w.h.agent.pubkey();
    let ir = hex(&w.fx["bounty"]["target_ir_digest"]);
    let ix = w.open_ix(&seller.pubkey(), &w.s, w.args(1, hk, ONE, bt::COND_TARGET, ir));
    rejects(send(&mut w.e.svm, &seller, &[], vec![ix]), "Unauthorized");
    // The buyer can.
    let ix = withdraw_ix(&w, &buyer.pubkey(), &w.s, &buyer_line, 2 * ONE);
    ok(send(&mut w.e.svm, &buyer, &[], vec![ix]));
    assert_eq!(balance(&w.e.svm, &buyer_line), 2 * ONE);
    let ix = w.open_ix(&buyer.pubkey(), &w.s, w.args(1, hk, ONE, bt::COND_TARGET, ir));
    ok(send(&mut w.e.svm, &buyer, &[], vec![ix]));
    let b = bounty_pda(&s, 1);
    let cancel = |signer: &Pubkey| {
        let accounts = ll::accounts::CancelBounty {
            r: ll::accounts::RefundBounty { launch_config: launch_config(), bounty_config: bcfg(), authority: launch_authority(), bounty: b,
                bounty_vault: bounty_vault(&b), opener: buyer.pubkey(), payer_launch: w.s.launch, payer_compute: cv, line_mint: w.e.line_mint,
                line_token_program: w.e.line_program },
            registry_config: registry_config(), signer: *signer, payer_record: agent_record(&s),
        };
        Instruction { program_id: ll::ID, accounts: accounts.to_account_metas(None), data: ll::instruction::CancelBounty {}.data() }
    };
    let ix = cancel(&seller.pubkey());
    rejects(send(&mut w.e.svm, &seller, &[], vec![ix]), "Unauthorized");
    let ix = cancel(&buyer.pubkey());
    ok(send(&mut w.e.svm, &buyer, &[], vec![ix]));
    // A wrong registry record (another agent's, owned by the caller) is refused.
    let ix = w.open_ix(&buyer.pubkey(), &w.s, w.args(2, hk, ONE, bt::COND_TARGET, ir));
    let mut ix2 = ix.clone();
    let last = ix2.accounts.len() - 1;
    ix2.accounts[last].pubkey = agent_record(&w.h.agent.pubkey());
    assert!(send(&mut w.e.svm, &buyer, &[], vec![ix2]).is_err());
    ok(send(&mut w.e.svm, &buyer, &[], vec![ix]));
}

/// A1-04: `release_bounty` read `Epoch.record_root` but ignored the challenge hold `claim` applies
/// (SPEC 10.8), so an escrow could be paid on a root during its challenge window or while an epoch
/// challenge was open, and a root later corrected by an upheld challenge had already paid out
/// (`resolve_challenge` only checks the registry's own claim counter). Release now waits like a claim.
#[test]
fn audit_a1_04_bounty_release_waits_for_the_challenge_hold() {
    let mut w = world();
    let admin = w.e.admin.insecure_clone();
    let window = 600;
    let ix = w.e.set_challenge_config_ix(&admin.pubkey(), lr::ChallengeConfigArgs { window_s: window, bond: ONE, reward: 0, resolve_timeout_s: 3_600,
        paused: false });
    ok(send(&mut w.e.svm, &admin, &[], vec![ix]));
    w.post(1);
    let (hk, k2) = (w.h.agent.pubkey(), w.commitment("c2"));
    ok(w.open(w.args(1, hk, 5 * ONE, bt::COND_COMMITMENT, k2)));
    w.post(2);
    rejects(w.release(1, "H", "c2"), "BountyHeld");
    // An epoch challenge on epoch 2 keeps it held past the window until Core resolves it.
    let (owner, owner_token) = w.e.wallet(1_100 * ONE);
    let ch = Keypair::new();
    w.e.register_verifier(&owner, &ch);
    let subject = lr::epoch_subject(2);
    let ix = w.e.open_challenge_ix(&ch.pubkey(), &ch.pubkey(), &owner.pubkey(), &owner_token,
        lr::OpenChallengeArgs { kind: lr::KIND_EPOCH, subject, epoch: 2, claim: [0; 32] });
    ok(send(&mut w.e.svm, &owner, &[&ch], vec![ix]));
    warp(&mut w.e.svm, window);
    rejects(w.release(1, "H", "c2"), "BountyHeld");
    let core = w.e.core.insecure_clone();
    let ix = w.e.resolve_challenge_ix(&core.pubkey(), lr::KIND_EPOCH, &subject, 2, &owner_token,
        lr::ResolveChallengeArgs { outcome: lr::CH_VOID, evidence: [0; 32], corrected: None }, None);
    ok(send(&mut w.e.svm, &core, &[], vec![ix]));
    ok(w.release(1, "H", "c2"));
    assert_eq!(w.bounty(1).status, bt::STATUS_RELEASED);
}
