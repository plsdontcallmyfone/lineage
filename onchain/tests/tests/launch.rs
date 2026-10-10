//! units_launch on LiteSVM against mainnet's pump.fun builds (Pump, PumpSwap, Pump Fees, Mayhem;
//! vendor/pump): an agent coin created by `create_v2` and registered in the same transaction, the
//! spoofing attempts `register_pump_launch` refuses, trades on the curve, the fee crank's exact split
//! after pump.fun's sweeps and collects, completion, `migrate_v2`, the graduation record and the
//! pool's creator fees, the removed Meteora instructions, usage roots and compute debits,
//! self-hosted withdrawals, sleep and wake, pause, and Meteora-era records (devnet history).
#![allow(clippy::result_large_err)]
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::system_program;
use anchor_lang::{InstructionData, ToAccountMetas};
use units_onchain_tests::*;

fn split(fees: u64) -> (u64, u64) {
    let c = (fees as u128 * 7000 / 10_000) as u64;
    (c, fees - c)
}

fn set_launch(e: &mut Env, f: impl FnOnce(&mut ll::LaunchConfigArgs)) {
    let admin = e.admin.insecure_clone();
    let mut args = launch_args(&admin.pubkey(), &e.runtime.pubkey(), &e.compute_sink);
    f(&mut args);
    ok(send(&mut e.svm, &admin, &[], vec![set_launch_config_ix(admin.pubkey(), args)]));
}

/// create_v2 with `shape`, then register_pump_launch for (agent, mint), in one transaction.
fn launch_shaped(e: &mut Env, agent: &Keypair, shape: CreateShape, between: Vec<Instruction>) -> (litesvm::types::TransactionResult, Keypair, Keypair) {
    let (launcher, _) = e.wallet(0);
    let mint = Keypair::new();
    let mut ixs = vec![cu(800_000), e.create_ix(&launcher.pubkey(), &agent.pubkey(), &mint.pubkey(), shape)];
    ixs.extend(between);
    ixs.push(e.register_launch_ix(&launcher.pubkey(), &agent.pubkey(), &mint.pubkey(), default_launch_args()));
    let r = send_unchecked(&mut e.svm, &launcher, &[agent, &mint], ixs);
    (r, launcher, mint)
}

#[test]
fn full_launch_records_everything() {
    let mut e = setup(LineKind::PumpCoin);
    let agent = Keypair::new();
    let l = e.launch_agent(agent, default_launch_args());
    let la: ll::AgentLaunch = read(&e.svm, &l.launch);
    assert_eq!((la.agent, la.mint, la.launcher), (l.agent.pubkey(), l.mint, l.launcher.pubkey()));
    assert_eq!((la.venue, la.bonding_curve, la.pump_creator, la.pump_pool), (ll::VENUE_PUMP, l.bonding_curve, l.pump_creator, Pubkey::default()));
    assert_eq!(la.repo_id, lr::leaf::repo_id(b"https://github.com/lineage-test/base58"));
    assert!(la.hosted && !la.graduated && !la.awake);
    let c = pf::curve_view(&e.svm, &l.mint);
    assert_eq!((c.creator, c.quote_mint, c.real_quote), (l.pump_creator, e.line_mint, 0));
    let a = e.agent(&l.agent.pubkey());
    assert_eq!((a.owner, a.mint), (l.launcher.pubkey(), l.mint));
    assert_eq!(balance(&e.svm, &l.compute_vault), 0);
    let lc: ll::LaunchConfig = read(&e.svm, &launch_config());
    assert_eq!((lc.venue, lc.pump_creator_fee_bps, lc.reserved), (ll::VENUE_PUMP, 0, 0));
    // One agent per key: the same agent cannot launch a second coin.
    let (r, _, _) = launch_shaped(&mut e, &l.agent, CreateShape::default(), vec![]);
    rejects(r, "already in use");
}

/// Every way to attach a curve that is not the agent's fresh `$LINE`-quoted coin is refused.
#[test]
fn register_refuses_spoofed_curves() {
    let mut e = setup(LineKind::PumpCoin);
    let agent = Keypair::new();
    // Another creator (the launcher's own wallet, or another agent's PDA).
    let other = Keypair::new();
    let (r, _, _) = launch_shaped(&mut e, &agent, CreateShape { creator: Some(pump_creator(&other.pubkey())), ..Default::default() }, vec![]);
    rejects(r, "PumpWrongCreator");
    // Quoted in SOL, not $LINE.
    let (r, _, _) = launch_shaped(&mut e, &agent, CreateShape { quote: Some(pf::WSOL), ..Default::default() }, vec![]);
    rejects(r, "PumpWrongQuote");
    // Quoted in another pump coin.
    let admin = e.admin.insecure_clone();
    let fake_line = Keypair::new();
    ok(send(&mut e.svm, &admin, &[&fake_line], vec![cu(400_000), pf::create_v2_ix(&fake_line.pubkey(), &admin.pubkey(), &admin.pubkey(), "Fake", "FAKE",
        &pf::Quote::Sol, false, 0, false)]));
    let (r, _, _) = launch_shaped(&mut e, &agent, CreateShape { quote: Some(fake_line.pubkey()), ..Default::default() }, vec![]);
    rejects(r, "PumpWrongQuote");
    // A creator fee rate other than the configured one (0).
    let (r, _, _) = launch_shaped(&mut e, &agent, CreateShape { creator_fee_bps: 150, ..Default::default() }, vec![]);
    rejects(r, "PumpCreatorFee");
    // A holder rewards coin.
    let (r, _, _) = launch_shaped(&mut e, &agent, CreateShape { holder_reward: true, ..Default::default() }, vec![]);
    let err = r.expect_err("holder rewards coin must be refused");
    assert!(err.meta.logs.iter().any(|l| l.contains("PumpCurveInvalid") || l.contains("PumpWrongCreator")), "{:#?}", err.meta.logs);
    // A trade between the create and the register: the curve is no longer fresh.
    let (r, launcher, mint) = {
        let (launcher, launcher_line) = e.wallet(1_000_000 * ONE);
        let _ = launcher_line;
        let mint = Keypair::new();
        let m = mint.pubkey();
        let ixs = vec![cu(900_000), e.create_ix(&launcher.pubkey(), &agent.pubkey(), &m, CreateShape::default()),
            create_ata_ix(&launcher.pubkey(), &launcher.pubkey(), &m, &T22),
            pf::buy_v3_ix(&m, &e.line_mint, &e.line_program, &launcher.pubkey(), 1_000 * ONE, 1_000_000 * ONE),
            e.register_launch_ix(&launcher.pubkey(), &agent.pubkey(), &m, default_launch_args())];
        (send_unchecked(&mut e.svm, &launcher, &[&agent, &mint], ixs), launcher, mint)
    };
    let _ = (launcher, mint);
    rejects(r, "PumpCurveInvalid");
    // A curve created in an earlier transaction (fresh, right creator and quote) cannot be registered later.
    let (launcher, _) = e.wallet(0);
    let mint = Keypair::new();
    let create = e.create_ix(&launcher.pubkey(), &agent.pubkey(), &mint.pubkey(), CreateShape::default());
    ok(send_unchecked(&mut e.svm, &launcher, &[&mint], vec![cu(400_000), create]));
    let ix = e.register_launch_ix(&launcher.pubkey(), &agent.pubkey(), &mint.pubkey(), default_launch_args());
    rejects(send_unchecked(&mut e.svm, &launcher, &[&agent], vec![cu(400_000), ix]), "NotCreatedInThisTx");
    // The curve of another mint passed for this mint.
    let (launcher, _) = e.wallet(0);
    let (m1, m2) = (Keypair::new(), Keypair::new());
    let mut ix = e.register_launch_ix(&launcher.pubkey(), &agent.pubkey(), &m2.pubkey(), default_launch_args());
    ix.accounts[6] = AccountMeta::new_readonly(pf::curve_of(&m1.pubkey()), false);
    let ixs = vec![cu(800_000), e.create_ix(&launcher.pubkey(), &agent.pubkey(), &m1.pubkey(), CreateShape::default()), ix];
    rejects(send_unchecked(&mut e.svm, &launcher, &[&agent, &m1], ixs), "PumpAccountInvalid");
    // A look-alike account (not owned by Pump) at a non-curve address.
    let (launcher, _) = e.wallet(0);
    let m3 = Keypair::new();
    let fake = Pubkey::new_unique();
    let mut data = e.svm.get_account(&pf::curve_of(&fake_line.pubkey())).unwrap().data;
    data[49..81].copy_from_slice(pump_creator(&agent.pubkey()).as_ref());
    data[83..115].copy_from_slice(e.line_mint.as_ref());
    e.svm.set_account(fake, solana_account::Account { lamports: 10_000_000, data, owner: ll::ID, executable: false, rent_epoch: 0 }).unwrap();
    let mut ix = e.register_launch_ix(&launcher.pubkey(), &agent.pubkey(), &m3.pubkey(), default_launch_args());
    ix.accounts[6] = AccountMeta::new_readonly(fake, false);
    let ixs = vec![cu(800_000), e.create_ix(&launcher.pubkey(), &agent.pubkey(), &m3.pubkey(), CreateShape::default()), ix];
    rejects(send_unchecked(&mut e.svm, &launcher, &[&agent, &m3], ixs), "PumpAccountInvalid");
    // The honest launch still works for this agent afterwards.
    let (r, _, _) = launch_shaped(&mut e, &agent, CreateShape::default(), vec![]);
    ok(r);
}

/// The admin's creator fee rate is the one launches must carry (owner decision 4: default 0).
#[test]
fn configured_creator_fee_rate_is_enforced() {
    let mut e = setup(LineKind::PumpCoin);
    set_launch(&mut e, |a| a.pump_creator_fee_bps = 150);
    let agent = Keypair::new();
    let (r, _, _) = launch_shaped(&mut e, &agent, CreateShape::default(), vec![]);
    rejects(r, "PumpCreatorFee");
    let (r, _, mint) = launch_shaped(&mut e, &agent, CreateShape { creator_fee_bps: 150, ..Default::default() }, vec![]);
    ok(r);
    assert_eq!(read::<ll::AgentLaunch>(&e.svm, &agent_launch(&mint.pubkey())).venue, ll::VENUE_PUMP);
    let admin = e.admin.insecure_clone();
    let args = ll::LaunchConfigArgs { pump_creator_fee_bps: 10_001, ..launch_args(&admin.pubkey(), &e.runtime.pubkey(), &e.compute_sink) };
    rejects(send(&mut e.svm, &admin, &[], vec![set_launch_config_ix(admin.pubkey(), args)]), "InvalidArgs");
}

#[test]
fn trades_and_an_exact_fee_split() {
    let mut e = setup(LineKind::PumpCoin);
    let l = e.launch_agent(Keypair::new(), default_launch_args());
    let (t, _tl, ta) = e.trader(&l, 5_000_000 * ONE);
    ok(e.curve_buy(&l, &t, 20_000_000 * ONE));
    ok(e.curve_sell(&l, &t, 5_000_000 * ONE));
    assert_eq!(balance(&e.svm, &ta), 15_000_000 * ONE);
    let fees = pf::curve_view(&e.svm, &l.mint).creator_fee;
    assert!(fees > 0);
    let (tr0, cv0) = (balance(&e.svm, &treasury()), balance(&e.svm, &l.compute_vault));
    ok(e.crank_fees(&l));
    let (c, p) = split(fees);
    assert_eq!(balance(&e.svm, &l.compute_vault), cv0 + c, "compute share exact");
    assert_eq!(balance(&e.svm, &treasury()), tr0 + p, "protocol share exact");
    assert_eq!(balance(&e.svm, &l.creator_line_token), 0);
    let la: ll::AgentLaunch = read(&e.svm, &l.launch);
    assert_eq!((la.fees_claimed, la.to_compute, la.to_protocol), (fees, c, p));
    // Nothing left: a second crank has nothing to split.
    rejects(e.crank_fees(&l), "NothingToClaim");
    // $LINE sent straight to the creator PDA's ATA is split as fees (a donation).
    e.fund(&l.creator_line_token, 10 * ONE);
    let ix = e.crank_ix(&l);
    let k = funded(&mut e.svm);
    ok(send(&mut e.svm, &k, &[], vec![ix]));
    assert_eq!(read::<ll::AgentLaunch>(&e.svm, &l.launch).fees_claimed, fees + 10 * ONE);
}

#[test]
fn crank_refuses_foreign_accounts() {
    let mut e = setup(LineKind::PumpCoin);
    let a = e.launch_agent(Keypair::new(), default_launch_args());
    let b = e.launch_agent(Keypair::new(), default_launch_args());
    let (t, _, _) = e.trader(&a, 5_000_000 * ONE);
    ok(e.curve_buy(&a, &t, 20_000_000 * ONE));
    let k = funded(&mut e.svm);
    let line = e.line_mint;
    ok(send(&mut e.svm, &k, &[], vec![create_ata_ix(&k.pubkey(), &a.pump_creator, &line, &e.line_program), create_ata_ix(&k.pubkey(), &b.pump_creator, &line, &e.line_program),
        pf::sweep_creator_fee_ix(&k.pubkey(), &a.mint, &line, &a.pump_creator), pf::collect_creator_fee_v2_ix(&a.pump_creator, &line)]));
    // B's record with A's creator ATA, A's record with B's compute vault, a non-treasury destination.
    let mut ix = e.crank_ix(&b);
    ix.accounts[3] = AccountMeta::new(a.creator_line_token, false);
    rejects(send(&mut e.svm, &k, &[], vec![ix]), "ConstraintTokenOwner");
    let mut ix = e.crank_ix(&a);
    ix.accounts[2] = AccountMeta::new_readonly(b.pump_creator, false);
    let err = send(&mut e.svm, &k, &[], vec![ix]).expect_err("another agent's creator PDA");
    assert!(err.meta.logs.iter().any(|l| l.contains("ConstraintSeeds") || l.contains("ConstraintHasOne")), "{:#?}", err.meta.logs);
    let mut ix = e.crank_ix(&a);
    ix.accounts[4] = AccountMeta::new(b.compute_vault, false);
    rejects(send(&mut e.svm, &k, &[], vec![ix]), "ConstraintSeeds");
    let mut ix = e.crank_ix(&a);
    ix.accounts[5] = AccountMeta::new(a.launcher_line, false);
    rejects(send(&mut e.svm, &k, &[], vec![ix]), "WrongTreasury");
    let ix = e.crank_ix(&a);
    ok(send(&mut e.svm, &k, &[], vec![ix]));
}

/// The Meteora instructions are gone from the program (owner decision 1, 2026-10-10).
#[test]
fn meteora_instructions_are_removed() {
    let mut e = setup(LineKind::PumpCoin);
    let k = funded(&mut e.svm);
    for name in ["launch_agent", "crank_fees", "graduate", "graduate_by_admin", "repoint_position", "crank_pool_fees"] {
        use sha2::Digest;
        let d = sha2::Sha256::digest(format!("global:{name}").as_bytes())[..8].to_vec();
        let ix = Instruction { program_id: ll::ID, accounts: vec![AccountMeta::new_readonly(launch_config(), false)], data: d };
        rejects(send(&mut e.svm, &k, &[], vec![ix]), "InstructionFallbackNotFound");
    }
}

fn record_ix(l: &Launched, pool: Pubkey) -> Instruction {
    Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::RecordPumpGraduation { launch_config: launch_config(), agent_launch: l.launch, bonding_curve: l.bonding_curve, pool }
            .to_account_metas(None),
        data: ll::instruction::RecordPumpGraduation {}.data(),
    }
}

/// The curve completes (synthetic migration), pump.fun migrates it, the graduation is recorded, and
/// the curve's and the pool's creator fees are cranked with the exact split.
#[test]
fn graduation_and_pool_fees() {
    let mut e = setup(LineKind::PumpCoin);
    let l = e.launch_agent(Keypair::new(), default_launch_args());
    let k = funded(&mut e.svm);
    rejects(send(&mut e.svm, &k, &[], vec![record_ix(&l, pf::pool_of(&l.mint, &e.line_mint))]), "NotMigrated");
    let (t, _tl, ta) = e.trader(&l, 400_000_000 * ONE);
    let c = pf::curve_view(&e.svm, &l.mint);
    let extra = 1_000_000 * ONE;
    let cap = pf::buy_cap(&e.svm, &l.mint, c.real_token) * 2;
    let ix = pf::buy_v3_ix(&l.mint, &e.line_mint, &e.line_program, &t.pubkey(), c.real_token + extra, cap);
    ok(send(&mut e.svm, &t, &[], vec![cu(600_000), ix]));
    assert!(pf::curve_view(&e.svm, &l.mint).complete);
    assert_eq!(balance(&e.svm, &ta), c.real_token + extra, "the completing buy's synthetic leg delivered the extra tokens");
    let curve_fees = pf::curve_view(&e.svm, &l.mint).creator_fee;
    ok(send(&mut e.svm, &k, &[], vec![cu(800_000), pf::migrate_v2_ix(&k.pubkey(), &l.mint, &e.line_mint, &e.line_program)]));
    let pool = pf::pool_of(&l.mint, &e.line_mint);
    // A wrong pool address (the curve) is refused; the canonical pool records.
    rejects(send(&mut e.svm, &k, &[], vec![record_ix(&l, l.bonding_curve)]), "PumpPoolUnexpected");
    ok(send(&mut e.svm, &k, &[], vec![record_ix(&l, pool)]));
    let la: ll::AgentLaunch = read(&e.svm, &l.launch);
    assert!(la.graduated && la.pump_pool == pool);
    rejects(send(&mut e.svm, &k, &[], vec![record_ix(&l, pool)]), "WrongPhase");
    // A pool trade, then one crank collects the curve's leftover and the pool's creator fees.
    let ix = pf::amm_buy_v2_ix(&pool, &l.mint, &e.line_mint, &t.pubkey(), 1_000_000 * ONE, 100_000_000 * ONE);
    ok(send(&mut e.svm, &t, &[], vec![cu(400_000), ix]));
    let pd = e.svm.get_account(&pool).unwrap().data;
    let pool_fees = u64::from_le_bytes(pd[pd.len() - 8..].try_into().unwrap());
    let coin_creator = Pubkey::new_from_array(pd[211..243].try_into().unwrap());
    assert_eq!(coin_creator, l.pump_creator, "Pool.coin_creator carried over to our PDA");
    assert!(pool_fees > 0);
    let (tr0, cv0) = (balance(&e.svm, &treasury()), balance(&e.svm, &l.compute_vault));
    ok(e.crank_fees(&l));
    let (cc, pp) = split(curve_fees + pool_fees);
    assert_eq!((balance(&e.svm, &l.compute_vault) - cv0, balance(&e.svm, &treasury()) - tr0), (cc, pp));
}

// ---------- usage, debits, withdrawals, sleep and wake, pause (venue-independent) ----------

fn post_usage_ix(signer: &Pubkey, epoch: u64, root: [u8; 32]) -> Instruction {
    Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::PostUsage { launch_config: launch_config(), registry_config: registry_config(), runtime_authority: *signer,
            usage: lpda(&[ll::USAGE_SEED, &epoch.to_le_bytes()]), system_program: system_program::ID }.to_account_metas(None),
        data: ll::instruction::PostUsage { epoch, root }.data(),
    }
}
fn debit_ix(e: &Env, signer: &Pubkey, epoch: u64, l: &Launched, args: ll::DebitArgs) -> Instruction {
    Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::DebitCompute {
            launch_config: launch_config(), runtime_authority: *signer, authority: launch_authority(), usage: lpda(&[ll::USAGE_SEED, &epoch.to_le_bytes()]),
            agent_launch: l.launch, receipt: lpda(&[ll::DEBIT_SEED, &epoch.to_le_bytes(), l.agent.pubkey().as_ref()]), compute_vault: l.compute_vault,
            compute_sink: e.compute_sink, line_mint: e.line_mint, line_token_program: e.line_program, system_program: system_program::ID,
        }.to_account_metas(None),
        data: ll::instruction::DebitCompute { args }.data(),
    }
}
fn withdraw_ix(e: &Env, launcher: &Pubkey, l: &Launched, to: &Pubkey, amount: u64) -> Instruction {
    Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::WithdrawCompute { launch_config: launch_config(), owner: *launcher, authority: launch_authority(), agent_launch: l.launch,
            compute_vault: l.compute_vault, owner_token: *to, line_mint: e.line_mint, line_token_program: e.line_program,
            agent_record: agent_record(&l.agent.pubkey()) }.to_account_metas(None),
        data: ll::instruction::WithdrawCompute { amount }.data(),
    }
}
fn refresh(e: &mut Env, l: &Launched) -> bool {
    let k = funded(&mut e.svm);
    let ix = Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::RefreshAwake { launch_config: launch_config(), agent_launch: l.launch, compute_vault: l.compute_vault }.to_account_metas(None),
        data: ll::instruction::RefreshAwake {}.data(),
    };
    ok(send(&mut e.svm, &k, &[], vec![ix]));
    read::<ll::AgentLaunch>(&e.svm, &l.launch).awake
}

#[test]
fn usage_root_from_typescript_and_compute_debits() {
    let mut e = setup(LineKind::PumpCoin);
    let f = fixtures();
    let b = e.launch_agent(seeded(12), default_launch_args());
    let epoch = f["usage"]["epoch"].as_u64().unwrap();
    let root = hex32(f["usage"]["root"].as_str().unwrap());
    let u = f["usage"]["leaves"].as_array().unwrap().iter().find(|u| u["agent"] == f["keys"]["B"]).unwrap().clone();
    let args = ll::DebitArgs {
        amount: u["amount"].as_str().unwrap().parse().unwrap(),
        model_tokens: u["model_tokens"].as_u64().unwrap(),
        sandbox_s: u["sandbox_s"].as_u64().unwrap(),
        proof: u["proof"].as_array().unwrap().iter().map(|p| hex32(p.as_str().unwrap())).collect(),
    };
    let runtime = e.runtime.insecure_clone();
    let stranger = funded(&mut e.svm);
    rejects(send(&mut e.svm, &stranger, &[], vec![post_usage_ix(&stranger.pubkey(), epoch, root)]), "Unauthorized");
    ok(send(&mut e.svm, &runtime, &[], vec![post_usage_ix(&runtime.pubkey(), epoch, root)]));
    e.fund(&b.compute_vault, 2_500 * ONE);
    assert!(refresh(&mut e, &b), "awake at 2,500 (wake 2,000)");
    let ix = debit_ix(&e, &stranger.pubkey(), epoch, &b, args.clone());
    rejects(send(&mut e.svm, &stranger, &[], vec![ix]), "Unauthorized");
    let ix = debit_ix(&e, &runtime.pubkey(), epoch, &b, ll::DebitArgs { amount: args.amount + 1, ..args.clone() });
    rejects(send(&mut e.svm, &runtime, &[], vec![ix]), "BadProof");
    let sink0 = balance(&e.svm, &e.compute_sink);
    let ix = debit_ix(&e, &runtime.pubkey(), epoch, &b, args.clone());
    ok(send(&mut e.svm, &runtime, &[], vec![ix]));
    assert_eq!(balance(&e.svm, &e.compute_sink), sink0 + args.amount);
    assert_eq!(balance(&e.svm, &b.compute_vault), 2_500 * ONE - args.amount);
    let ix = debit_ix(&e, &runtime.pubkey(), epoch, &b, args.clone());
    rejects(send(&mut e.svm, &runtime, &[], vec![ix]), "already in use");
    let la: ll::AgentLaunch = read(&e.svm, &b.launch);
    assert_eq!(la.debited, args.amount);
    let ix = withdraw_ix(&e, &b.launcher.pubkey(), &b, &b.launcher_line, 1);
    rejects(send(&mut e.svm, &b.launcher, &[], vec![ix]), "Hosted");
}

#[test]
fn self_hosted_withdrawals_and_sleep_wake() {
    let mut e = setup(LineKind::PumpCoin);
    let l = e.launch_agent(Keypair::new(), ll::PumpLaunchArgs { hosted: false, identity_mode: ll::IDENTITY_TOKEN, ..default_launch_args() });
    assert!(!refresh(&mut e, &l));
    e.fund(&l.compute_vault, 2_500 * ONE);
    assert!(refresh(&mut e, &l));
    let (stranger, stranger_line) = e.wallet(0);
    let ix = withdraw_ix(&e, &stranger.pubkey(), &l, &stranger_line, ONE);
    rejects(send(&mut e.svm, &stranger, &[], vec![ix]), "Unauthorized");
    let launcher = l.launcher.insecure_clone();
    let ix = withdraw_ix(&e, &launcher.pubkey(), &l, &l.launcher_line, 1_000 * ONE);
    ok(send(&mut e.svm, &launcher, &[], vec![ix]));
    assert!(read::<ll::AgentLaunch>(&e.svm, &l.launch).awake);
    let ix = withdraw_ix(&e, &launcher.pubkey(), &l, &l.launcher_line, 600 * ONE);
    ok(send(&mut e.svm, &launcher, &[], vec![ix]));
    assert!(!read::<ll::AgentLaunch>(&e.svm, &l.launch).awake);
    assert_eq!(balance(&e.svm, &l.launcher_line), 1_600 * ONE);
    e.fund(&l.compute_vault, 900 * ONE);
    assert!(!refresh(&mut e, &l));
    e.fund(&l.compute_vault, 200 * ONE);
    assert!(refresh(&mut e, &l));
    assert_eq!(read::<ll::AgentLaunch>(&e.svm, &l.launch).withdrawn, 1_600 * ONE);
}

#[test]
fn launch_pause() {
    let mut e = setup(LineKind::PumpCoin);
    let l = e.launch_agent(Keypair::new(), default_launch_args());
    let (t, _, _) = e.trader(&l, 5_000_000 * ONE);
    ok(e.curve_buy(&l, &t, 10_000_000 * ONE));
    set_launch(&mut e, |a| a.paused = true);
    rejects(e.crank_fees(&l), "Paused");
    let (launcher, _) = e.wallet(0);
    rejects(e.try_launch(&launcher, &Keypair::new(), &Keypair::new(), default_launch_args()), "Paused");
    set_launch(&mut e, |a| a.paused = false);
    ok(e.crank_fees(&l));
}

/// A runtime key posts usage epochs only in sequence and not ahead of the clock, debits only hosted
/// agents, and never more than `max_debit_per_epoch` per epoch.
#[test]
fn usage_sequence_hosted_only_and_debit_cap() {
    let mut e = setup(LineKind::PumpCoin);
    let runtime = e.runtime.insecure_clone();
    let len = test_params().epoch_length_s as i64;
    let hosted = e.launch_agent(Keypair::new(), default_launch_args());
    let selfh = e.launch_agent(Keypair::new(), ll::PumpLaunchArgs { hosted: false, ..default_launch_args() });
    e.fund(&hosted.compute_vault, 3_000 * ONE);
    e.fund(&selfh.compute_vault, 3_000 * ONE);
    let leaf = |epoch: u64, l: &Launched, amount: u64| lr::leaf::usage_leaf(epoch, &l.agent.pubkey().to_bytes(), amount, 10, 20);
    let dargs = |amount: u64| ll::DebitArgs { amount, model_tokens: 10, sandbox_s: 20, proof: vec![] };
    let post = |e: &mut Env, epoch: u64, root: [u8; 32]| send(&mut e.svm, &runtime, &[], vec![post_usage_ix(&runtime.pubkey(), epoch, root)]);
    ok(post(&mut e, 40, leaf(40, &selfh, 100 * ONE)));
    rejects(post(&mut e, 42, [0; 32]), "UsageOrder");
    rejects(post(&mut e, 39, [0; 32]), "UsageOrder");
    ok(post(&mut e, 41, leaf(41, &hosted, 500 * ONE)));
    rejects(post(&mut e, 42, [0; 32]), "UsageOrder");
    let lc: ll::LaunchConfig = read(&e.svm, &launch_config());
    assert_eq!((lc.usage_epochs_posted, lc.last_usage_epoch, lc.usage_anchor, lc.usage_anchor_ts), (2, 41, 40, NOW));
    let ix = debit_ix(&e, &runtime.pubkey(), 40, &selfh, dargs(100 * ONE));
    rejects(send(&mut e.svm, &runtime, &[], vec![ix]), "NotHosted");
    set_launch(&mut e, |a| a.max_debit_per_epoch = 500 * ONE - 1);
    let ix = debit_ix(&e, &runtime.pubkey(), 41, &hosted, dargs(500 * ONE));
    rejects(send(&mut e.svm, &runtime, &[], vec![ix]), "DebitCap");
    set_launch(&mut e, |a| a.max_debit_per_epoch = 500 * ONE);
    let ix = debit_ix(&e, &runtime.pubkey(), 41, &hosted, dargs(500 * ONE));
    ok(send(&mut e.svm, &runtime, &[], vec![ix]));
    assert_eq!(balance(&e.svm, &hosted.compute_vault), 2_500 * ONE);
    warp(&mut e.svm, len);
    ok(post(&mut e, 42, [0; 32]));
    let admin = e.admin.insecure_clone();
    let args = ll::LaunchConfigArgs { compute_sink: Pubkey::default(), ..launch_args(&admin.pubkey(), &e.runtime.pubkey(), &e.compute_sink) };
    rejects(send(&mut e.svm, &admin, &[], vec![set_launch_config_ix(admin.pubkey(), args)]), "InvalidArgs");
}

/// A record the Meteora venue wrote (devnet history: same bytes, a DBC config in `venue`) keeps its
/// compute paths (debit, withdraw, refresh, bounties) and is refused by the pump.fun crank and
/// graduation record.
#[test]
fn meteora_era_records_stay_readable() {
    let mut e = setup(LineKind::PumpCoin);
    let l = e.launch_agent(Keypair::new(), ll::PumpLaunchArgs { hosted: false, ..default_launch_args() });
    let mut acct = e.svm.get_account(&l.launch).unwrap();
    let dbc_config = Pubkey::new_unique();
    let o = 8 + 32 * 3 + 32 + 4 + l_repo_len(&acct.data) + 2;
    acct.data[o..o + 32].copy_from_slice(dbc_config.as_ref());
    e.svm.set_account(l.launch, acct).unwrap();
    let la: ll::AgentLaunch = read(&e.svm, &l.launch);
    assert_eq!(la.venue, dbc_config);
    e.fund(&l.compute_vault, 2_500 * ONE);
    assert!(refresh(&mut e, &l));
    let launcher = l.launcher.insecure_clone();
    let ix = withdraw_ix(&e, &launcher.pubkey(), &l, &l.launcher_line, ONE);
    ok(send(&mut e.svm, &launcher, &[], vec![ix]));
    let k = funded(&mut e.svm);
    let (pc, line) = (l.pump_creator, e.line_mint);
    ok(send(&mut e.svm, &k, &[], vec![create_ata_ix(&k.pubkey(), &pc, &line, &e.line_program)]));
    e.fund(&l.creator_line_token, ONE);
    let ix = e.crank_ix(&l);
    rejects(send(&mut e.svm, &k, &[], vec![ix]), "WrongPhase");
    rejects(send(&mut e.svm, &k, &[], vec![record_ix(&l, pf::pool_of(&l.mint, &e.line_mint))]), "WrongPhase");
}
fn l_repo_len(d: &[u8]) -> usize {
    let o = 8 + 32 * 3 + 32;
    u32::from_le_bytes(d[o..o + 4].try_into().unwrap()) as usize
}
/// The devnet LaunchConfig was written by the first layout; `migrate_launch_config` grows it.
#[test]
fn migrate_launch_config_from_the_first_layout() {
    let mut e = setup(LineKind::PumpCoin);
    let key = launch_config();
    let mut acct = e.svm.get_account(&key).unwrap();
    let full = acct.data.len();
    acct.data.truncate(full - ll::LAUNCH_CONFIG_V1_TAIL);
    acct.lamports = e.svm.minimum_balance_for_rent_exemption(acct.data.len());
    e.svm.set_account(key, acct).unwrap();
    let ix = |signer: Pubkey| Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::MigrateLaunchConfig { launch_config: key, admin: signer, system_program: system_program::ID }.to_account_metas(None),
        data: ll::instruction::MigrateLaunchConfig { max_debit_per_epoch: 99 }.data(),
    };
    let stranger = funded(&mut e.svm);
    rejects(send(&mut e.svm, &stranger, &[], vec![ix(stranger.pubkey())]), "Unauthorized");
    let admin = e.admin.insecure_clone();
    ok(send(&mut e.svm, &admin, &[], vec![ix(admin.pubkey())]));
    let lc: ll::LaunchConfig = read(&e.svm, &key);
    assert_eq!((lc.max_debit_per_epoch, lc.usage_epochs_posted, lc.registry_program, lc.agent_compute_bps), (99, 0, lr::ID, 7000));
    assert_eq!(e.svm.get_account(&key).unwrap().data.len(), full);
    rejects(send(&mut e.svm, &admin, &[], vec![ix(admin.pubkey())]), "InvalidArgs");
    let l = e.launch_agent(Keypair::new(), default_launch_args());
    assert!(read::<ll::AgentLaunch>(&e.svm, &l.launch).hosted);
}
