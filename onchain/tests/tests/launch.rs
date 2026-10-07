//! lineage_launch on LiteSVM against the real Meteora DBC and DAMM v2 builds: DBC config checks,
//! a full agent launch, trades on the curve, the fee crank's exact split, Meteora's migration to
//! DAMM v2, graduation, the locked position's fees, usage roots and compute debits, self-hosted
//! withdrawals, sleep and wake, pause.
use anchor_lang::solana_program::instruction::{AccountMeta, Instruction};
use anchor_lang::solana_program::system_program;
use anchor_lang::{InstructionData, ToAccountMetas};
use lineage_onchain_tests::*;

const BUY: u8 = 0; // ExactIn
const PARTIAL_FILL: u8 = 1;

fn split(fees: u64) -> (u64, u64) {
    let c = (fees as u128 * 7000 / 10_000) as u64;
    (c, fees - c)
}

#[test]
fn dbc_config_offsets_and_checks() {
    let mut e = setup(LineKind::Classic);
    let admin = e.admin.insecure_clone();
    let (rt, sink) = (e.runtime.pubkey(), e.compute_sink);
    let args = launch_args(&admin.pubkey(), &rt, &sink);
    let line = e.line_mint;
    let auth = launch_authority();
    let base = standard_dbc_params();
    // The offsets the program reads, against what DBC writes.
    let (r, k) = create_dbc_config(&mut e.svm, &admin, &line, &auth, &DbcParams { creator_trading_fee: 50, ..base });
    ok(r);
    let d = e.svm.get_account(&k).unwrap().data;
    assert_eq!(d[ll::meteora::dbc_config::CREATOR_TRADING_FEE_PERCENTAGE], 50);
    rejects(send(&mut e.svm, &admin, &[], vec![set_launch_config_ix(admin.pubkey(), args, k)]), "DbcConfigInvalid");
    let (r, k) = create_dbc_config(&mut e.svm, &admin, &line, &auth, &DbcParams { partner_locked: 60, creator_locked: 40, ..base });
    ok(r);
    let d = e.svm.get_account(&k).unwrap().data;
    assert_eq!((d[ll::meteora::dbc_config::PARTNER_PERMANENT_LOCKED], d[ll::meteora::dbc_config::CREATOR_PERMANENT_LOCKED]), (60, 40));
    rejects(send(&mut e.svm, &admin, &[], vec![set_launch_config_ix(admin.pubkey(), args, k)]), "DbcConfigInvalid");
    let std = e.svm.get_account(&e.dbc_config).unwrap().data;
    use ll::meteora::dbc_config as c;
    assert_eq!(u64::from_le_bytes(std[c::MIGRATION_QUOTE_THRESHOLD..c::MIGRATION_QUOTE_THRESHOLD + 8].try_into().unwrap()), base.threshold);
    assert_eq!(u128::from_le_bytes(std[c::SQRT_START_PRICE..c::SQRT_START_PRICE + 16].try_into().unwrap()), base.sqrt_start);
    // Fees in both tokens, a fee claimer that is not our PDA, another quote mint: refused.
    for (p, claimer, quote) in [
        (DbcParams { collect_fee_mode: 1, ..base }, auth, line),
        (base, Pubkey::new_unique(), line),
    ] {
        let (r, k) = create_dbc_config(&mut e.svm, &admin, &quote, &claimer, &p);
        ok(r);
        rejects(send(&mut e.svm, &admin, &[], vec![set_launch_config_ix(admin.pubkey(), args, k)]), "DbcConfigInvalid");
    }
    let (other_line, _) = create_line(&mut e.svm, &admin, LineKind::Classic);
    let (r, k) = create_dbc_config(&mut e.svm, &admin, &other_line, &auth, &base);
    ok(r);
    rejects(send(&mut e.svm, &admin, &[], vec![set_launch_config_ix(admin.pubkey(), args, k)]), "DbcConfigInvalid");
    // Admin only; the splits must sum to 10,000; thresholds ordered.
    let stranger = funded(&mut e.svm);
    let dc = e.dbc_config;
    rejects(send(&mut e.svm, &stranger, &[], vec![set_launch_config_ix(stranger.pubkey(), args, dc)]), "Unauthorized");
    let bad = ll::LaunchConfigArgs { protocol_bps: 3001, ..args };
    rejects(send(&mut e.svm, &admin, &[], vec![set_launch_config_ix(admin.pubkey(), bad, dc)]), "InvalidArgs");
    let bad = ll::LaunchConfigArgs { sleep_threshold: 3, wake_threshold: 2, ..args };
    rejects(send(&mut e.svm, &admin, &[], vec![set_launch_config_ix(admin.pubkey(), bad, dc)]), "InvalidArgs");
    let new = ll::LaunchConfigArgs { agent_compute_bps: 6000, protocol_bps: 4000, ..args };
    ok(send(&mut e.svm, &admin, &[], vec![set_launch_config_ix(admin.pubkey(), new, dc)]));
    let lc: ll::LaunchConfig = read(&e.svm, &launch_config());
    assert_eq!((lc.agent_compute_bps, lc.protocol_bps, lc.migration_quote_threshold, lc.sqrt_start_price), (6000, 4000, base.threshold, base.sqrt_start));
}

#[test]
fn full_launch_records_everything() {
    for kind in [LineKind::Classic, LineKind::Pump] {
        let mut e = setup(kind);
        let f = fixtures();
        let agent = seeded(12);
        let (launcher, _) = e.wallet(0);
        let mint = Keypair::new();
        let ix = e.launch_ix(&launcher.pubkey(), &agent.pubkey(), &mint.pubkey(), default_launch_args());
        let size = tx_size(&launcher, &[&agent, &mint], &[cu(400_000), ix.clone()]);
        println!("launch_agent transaction: {size} bytes, {} accounts", ix.accounts.len());
        let meta = ok(send(&mut e.svm, &launcher, &[&agent, &mint], vec![cu(400_000), ix]));
        println!("launch_agent compute units: {}", meta.compute_units_consumed);
        let m = mint.pubkey();
        let l: ll::AgentLaunch = read(&e.svm, &agent_launch(&m));
        assert_eq!((l.agent, l.mint, l.launcher, l.hosted, l.identity_mode, l.graduated, l.awake), (agent.pubkey(), m, launcher.pubkey(), true,
            ll::IDENTITY_APP, false, false));
        assert_eq!(l.repo_url, "https://github.com/lineage-test/base58");
        assert_eq!(l.repo_id, hex32(f["repo"]["repo_id"].as_str().unwrap()), "repo_id equals protocol repoId()");
        assert_eq!(l.dbc_pool, dbc_pool_of(&e.dbc_config, &m, &e.line_mint));
        let a = e.agent(&agent.pubkey());
        assert_eq!((a.kind, a.owner, a.mint, a.hosted, a.bond, a.burned), (lr::KIND_LAUNCHED, launcher.pubkey(), m, true, 0, 0));
        // The agent mint is DBC's Token-2022 mint with the fixed supply in the curve vault.
        assert_eq!(program_of(&e.svm, &m), T22);
        assert_eq!(supply(&e.svm, &m), 100_000_000 * ONE);
        let pool = e.svm.get_account(&l.dbc_pool).unwrap().data;
        assert_eq!(Pubkey::new_from_array(pool[104..136].try_into().unwrap()), launch_authority(), "our PDA is the pool creator");
        assert_eq!(balance(&e.svm, &compute_vault(&agent.pubkey())), 0);
        // One launch per agent key.
        let (l2, _) = e.wallet(0);
        assert!(e.try_launch(&l2, &agent, &Keypair::new(), default_launch_args()).is_err());
        // Non-canonical repository URLs are refused (Core's repoId would differ).
        for url in ["https://github.com/Lineage-Test/x", "https://github.com/a/b/", "https://github.com/a/b.git", "http://github.com/a/b", "https://github.com/a b"] {
            let args = ll::LaunchArgs { repo_url: url.into(), ..default_launch_args() };
            rejects(e.try_launch(&l2, &Keypair::new(), &Keypair::new(), args), "InvalidUrl");
        }
        let args = ll::LaunchArgs { identity_mode: 3, ..default_launch_args() };
        rejects(e.try_launch(&l2, &Keypair::new(), &Keypair::new(), args), "InvalidArgs");
    }
}

#[test]
fn trades_and_an_exact_fee_split() {
    for kind in [LineKind::Classic, LineKind::Pump] {
        let mut e = setup(kind);
        let l = e.launch_agent(Keypair::new(), default_launch_args());
        rejects(e.crank_fees(&l), "NothingToClaim");
        let (t, tl, ta) = e.trader(&l, 2_000_000 * ONE);
        ok(e.dbc_swap(&l, &t, &tl, &ta, true, 1_000_000 * ONE, 1, BUY));
        let got = balance(&e.svm, &ta);
        assert!(got > 0);
        ok(e.dbc_swap(&l, &t, &tl, &ta, false, got / 2, 1, BUY));
        let v = dbc_view(&e.svm, &l.dbc_pool);
        assert!(v.partner_quote_fee > 0 && v.protocol_quote_fee > 0);
        let fees = v.partner_quote_fee;
        let (want_c, want_p) = split(fees);
        let (c0, t0) = (balance(&e.svm, &l.compute_vault), balance(&e.svm, &treasury()));
        let meta = ok(e.crank_fees(&l));
        println!("crank_fees compute units: {}", meta.compute_units_consumed);
        let (c1, t1) = (balance(&e.svm, &l.compute_vault), balance(&e.svm, &treasury()));
        assert_eq!((c1 - c0, t1 - t0), (want_c, want_p), "compute and treasury get exactly floor(70%) and the rest");
        assert_eq!(c1 - c0 + t1 - t0, fees, "nothing lost or created");
        let la: ll::AgentLaunch = read(&e.svm, &l.launch);
        assert_eq!((la.fees_claimed, la.to_compute, la.to_protocol), (fees, want_c, want_p));
        assert_eq!(la.awake, c1 >= 2_000 * ONE);
        assert_eq!(dbc_view(&e.svm, &l.dbc_pool).partner_quote_fee, 0);
        assert_eq!(balance(&e.svm, &l.authority_agent_token), 0, "no agent tokens taken");
        rejects(e.crank_fees(&l), "NothingToClaim");
        // A treasury that is not the registry's is refused.
        let (_, fake) = e.wallet(0);
        let mut ix = e.crank_fees_ix(&l);
        ix.accounts[11].pubkey = fake;
        let k = funded(&mut e.svm);
        rejects(send(&mut e.svm, &k, &[], vec![cu(400_000), ix]), "WrongTreasury");
        // Fees then reach the epoch pool through split.
        let ix = e.split_ix();
        ok(send(&mut e.svm, &k, &[], vec![ix]));
        assert_eq!(balance(&e.svm, &reserve_vault()) + balance(&e.svm, &pool_vault()), want_p);
    }
}

struct Damm {
    pool: Pubkey,
    position: Pubkey,
    nft_account: Pubkey,
    token_a_vault: Pubkey,
    token_b_vault: Pubkey,
    second: Option<(Pubkey, Pubkey)>,
}

/// Meteora's own permissionless migration (a keeper's call): DBC `migration_damm_v2`.
fn migrate(e: &mut Env, l: &Launched) -> (litesvm::types::TransactionResult, Damm) {
    let (hi, lo) = max_min(&l.mint, &e.line_mint);
    let pool = pda_of(&[b"pool", DAMM_DYNAMIC_CONFIG.as_ref(), hi.as_ref(), lo.as_ref()], &DAMM);
    let (m1, m2) = (Keypair::new(), Keypair::new());
    let pos = |m: &Keypair| (pda_of(&[b"position", m.pubkey().as_ref()], &DAMM), pda_of(&[b"position_nft_account", m.pubkey().as_ref()], &DAMM));
    let (p1, n1) = pos(&m1);
    let (p2, n2) = pos(&m2);
    let token_a_vault = pda_of(&[b"token_vault", l.mint.as_ref(), pool.as_ref()], &DAMM);
    let token_b_vault = pda_of(&[b"token_vault", e.line_mint.as_ref(), pool.as_ref()], &DAMM);
    let keeper = funded(&mut e.svm);
    let ix = Instruction {
        program_id: DBC,
        accounts: vec![
            AccountMeta::new(l.dbc_pool, false), AccountMeta::new_readonly(DBC, false), AccountMeta::new_readonly(e.dbc_config, false),
            AccountMeta::new(ll::meteora::DBC_POOL_AUTHORITY, false), AccountMeta::new(pool, false),
            AccountMeta::new(m1.pubkey(), true), AccountMeta::new(n1, false), AccountMeta::new(p1, false),
            AccountMeta::new(m2.pubkey(), true), AccountMeta::new(n2, false), AccountMeta::new(p2, false),
            AccountMeta::new_readonly(ll::meteora::DAMM_POOL_AUTHORITY, false), AccountMeta::new_readonly(DAMM, false),
            AccountMeta::new(l.mint, false), AccountMeta::new(e.line_mint, false),
            AccountMeta::new(token_a_vault, false), AccountMeta::new(token_b_vault, false),
            AccountMeta::new(l.dbc_base_vault, false), AccountMeta::new(l.dbc_quote_vault, false),
            AccountMeta::new(keeper.pubkey(), true), AccountMeta::new_readonly(T22, false), AccountMeta::new_readonly(e.line_program, false),
            AccountMeta::new_readonly(T22, false), AccountMeta::new_readonly(damm_event_authority(), false),
            AccountMeta::new_readonly(system_program::ID, false), AccountMeta::new_readonly(DAMM_DYNAMIC_CONFIG, false),
        ],
        data: mt_disc("global:migration_damm_v2").to_vec(),
    };
    let r = send(&mut e.svm, &keeper, &[&m1, &m2], vec![cu(1_400_000), ix]);
    let second = e.svm.get_account(&p2).filter(|a| a.owner == DAMM).map(|_| (p2, n2));
    (r, Damm { pool, position: p1, nft_account: n1, token_a_vault, token_b_vault, second })
}

fn graduate_ix(l: &Launched, d: &Damm, position: Pubkey, nft: Pubkey, damm_config: Pubkey) -> Instruction {
    Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::Graduate { launch_config: launch_config(), authority: launch_authority(), agent_launch: l.launch, dbc_pool: l.dbc_pool,
            damm_pool: d.pool, position, position_nft_account: nft, damm_config }.to_account_metas(None),
        data: ll::instruction::Graduate {}.data(),
    }
}

fn crank_pool_ix(e: &Env, l: &Launched, d: &Damm) -> Instruction {
    Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::CrankPoolFees {
            launch_config: launch_config(), authority: launch_authority(), agent_launch: l.launch, damm_pool: d.pool, position: d.position,
            position_nft_account: d.nft_account, damm_token_a_vault: d.token_a_vault, damm_token_b_vault: d.token_b_vault, agent_mint: l.mint,
            line_mint: e.line_mint, authority_agent_token: l.authority_agent_token, compute_vault: l.compute_vault, treasury: treasury(),
            damm_pool_authority: ll::meteora::DAMM_POOL_AUTHORITY, damm_event_authority: ll::meteora::DAMM_EVENT_AUTHORITY, damm_program: DAMM,
            line_token_program: e.line_program, token_2022_program: T22,
        }.to_account_metas(None),
        data: ll::instruction::CrankPoolFees {}.data(),
    }
}

fn damm_swap(e: &mut Env, l: &Launched, d: &Damm, t: &Keypair, line_acct: &Pubkey, agent_acct: &Pubkey, buy: bool, amount_in: u64) {
    let (input, output) = if buy { (*line_acct, *agent_acct) } else { (*agent_acct, *line_acct) };
    let mut data = mt_disc("global:swap2").to_vec();
    data.extend_from_slice(&amount_in.to_le_bytes());
    data.extend_from_slice(&0u64.to_le_bytes());
    data.push(0);
    let ix = Instruction {
        program_id: DAMM,
        accounts: vec![AccountMeta::new_readonly(ll::meteora::DAMM_POOL_AUTHORITY, false), AccountMeta::new(d.pool, false),
            AccountMeta::new(input, false), AccountMeta::new(output, false), AccountMeta::new(d.token_a_vault, false),
            AccountMeta::new(d.token_b_vault, false), AccountMeta::new_readonly(l.mint, false),
            AccountMeta::new_readonly(e.line_mint, false), AccountMeta::new_readonly(t.pubkey(), true),
            AccountMeta::new_readonly(T22, false), AccountMeta::new_readonly(e.line_program, false), AccountMeta::new_readonly(DAMM, false),
            AccountMeta::new_readonly(damm_event_authority(), false), AccountMeta::new_readonly(DAMM, false)],
        data,
    };
    ok(send(&mut e.svm, t, &[], vec![cu(400_000), ix]));
}

#[test]
fn graduation_and_locked_pool_fees() {
    for kind in [LineKind::Classic, LineKind::Pump] {
        let mut e = setup(kind);
        let l = e.launch_agent(Keypair::new(), default_launch_args());
        // Buy out the curve in one PartialFill buy (the rest of the input stays with the buyer).
        let amount = 40_000_000 * ONE;
        let (whale, wl, wa) = e.trader(&l, amount);
        ok(e.dbc_swap(&l, &whale, &wl, &wa, true, amount, 1, PARTIAL_FILL));
        let v = dbc_view(&e.svm, &l.dbc_pool);
        assert_eq!(v.migration_progress, 2, "curve complete");
        // Graduation needs Meteora's migration first.
        let dummy = Damm { pool: Pubkey::new_unique(), position: Pubkey::new_unique(), nft_account: Pubkey::new_unique(), token_a_vault: Pubkey::new_unique(),
            token_b_vault: Pubkey::new_unique(), second: None };
        let k = funded(&mut e.svm);
        let ix = graduate_ix(&l, &dummy, dummy.position, dummy.nft_account, DAMM_DYNAMIC_CONFIG);
        rejects(send(&mut e.svm, &k, &[], vec![ix]), "NotMigrated");
        // The curve's fees (and any surplus) are cranked before migration.
        let fees = v.partner_quote_fee;
        let (c0, t0) = (balance(&e.svm, &l.compute_vault), balance(&e.svm, &treasury()));
        ok(e.crank_fees(&l));
        let got = balance(&e.svm, &l.compute_vault) - c0 + balance(&e.svm, &treasury()) - t0;
        assert!(got >= fees, "claimed at least the partner fee ({got} vs {fees})");
        assert_eq!(balance(&e.svm, &l.compute_vault) - c0, split(got).0);

        let (r, d) = migrate(&mut e, &l);
        let meta = ok(r);
        println!("DBC migration_damm_v2 compute units: {}", meta.compute_units_consumed);
        // A wrong position or config is refused; the real one graduates once.
        if let Some((p2, n2)) = d.second {
            let ix = graduate_ix(&l, &d, p2, n2, DAMM_DYNAMIC_CONFIG);
            assert!(send(&mut e.svm, &k, &[], vec![ix]).is_err());
        }
        let ix = graduate_ix(&l, &d, d.position, d.nft_account, e.dbc_config);
        rejects(send(&mut e.svm, &k, &[], vec![ix]), "DammPoolUnexpected");
        let ix = graduate_ix(&l, &d, d.position, d.nft_account, DAMM_DYNAMIC_CONFIG);
        ok(send(&mut e.svm, &k, &[], vec![ix]));
        let la: ll::AgentLaunch = read(&e.svm, &l.launch);
        assert!(la.graduated);
        assert_eq!((la.damm_pool, la.position, la.position_nft_account), (d.pool, d.position, d.nft_account));
        let ix = graduate_ix(&l, &d, d.position, d.nft_account, DAMM_DYNAMIC_CONFIG);
        rejects(send(&mut e.svm, &k, &[], vec![ix]), "WrongPhase");
        rejects(e.crank_fees(&l), "WrongPhase");

        // Trades on DAMM v2 earn the locked position fees; only our program can claim them.
        let (t, tl, ta) = e.trader(&l, 1_000_000 * ONE);
        damm_swap(&mut e, &l, &d, &t, &tl, &ta, true, 500_000 * ONE);
        let half = balance(&e.svm, &ta) / 2;
        damm_swap(&mut e, &l, &d, &t, &tl, &ta, false, half);
        let (c0, t0, s0) = (balance(&e.svm, &l.compute_vault), balance(&e.svm, &treasury()), supply(&e.svm, &l.mint));
        let ix = crank_pool_ix(&e, &l, &d);
        let meta = ok(send(&mut e.svm, &k, &[], vec![cu(400_000), ix]));
        println!("crank_pool_fees compute units: {}", meta.compute_units_consumed);
        let (dc, dt) = (balance(&e.svm, &l.compute_vault) - c0, balance(&e.svm, &treasury()) - t0);
        let fees = dc + dt;
        assert!(fees > 0, "position fees claimed");
        assert_eq!((dc, dt), split(fees));
        assert_eq!(balance(&e.svm, &l.authority_agent_token), 0, "any agent-token fees are burned, never kept");
        assert!(supply(&e.svm, &l.mint) <= s0);
        let la: ll::AgentLaunch = read(&e.svm, &l.launch);
        assert!(la.fees_claimed >= fees && la.to_compute + la.to_protocol == la.fees_claimed);
        let ix = crank_pool_ix(&e, &l, &d);
        rejects(send(&mut e.svm, &k, &[], vec![cu(400_000), ix]), "NothingToClaim");
    }
}

fn post_usage_ix(signer: &Pubkey, epoch: u64, root: [u8; 32]) -> Instruction {
    Instruction {
        program_id: ll::ID,
        accounts: ll::accounts::PostUsage { launch_config: launch_config(), runtime_authority: *signer, usage: lpda(&[ll::USAGE_SEED, &epoch.to_le_bytes()]),
            system_program: system_program::ID }.to_account_metas(None),
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
        accounts: ll::accounts::WithdrawCompute { launch_config: launch_config(), launcher: *launcher, authority: launch_authority(), agent_launch: l.launch,
            compute_vault: l.compute_vault, launcher_token: *to, line_mint: e.line_mint, line_token_program: e.line_program }.to_account_metas(None),
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
    let mut e = setup(LineKind::Pump);
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
    // Hosted compute is never withdrawn by the launcher.
    let ix = withdraw_ix(&e, &b.launcher.pubkey(), &b, &b.launcher_line, 1);
    rejects(send(&mut e.svm, &b.launcher, &[], vec![ix]), "Hosted");
}

#[test]
fn self_hosted_withdrawals_and_sleep_wake() {
    let mut e = setup(LineKind::Classic);
    let l = e.launch_agent(Keypair::new(), ll::LaunchArgs { hosted: false, identity_mode: ll::IDENTITY_TOKEN, ..default_launch_args() });
    assert!(!refresh(&mut e, &l));
    e.fund(&l.compute_vault, 2_500 * ONE);
    assert!(refresh(&mut e, &l));
    let stranger = funded(&mut e.svm);
    let ix = withdraw_ix(&e, &stranger.pubkey(), &l, &l.launcher_line, ONE);
    rejects(send(&mut e.svm, &stranger, &[], vec![ix]), "Unauthorized");
    let launcher = l.launcher.insecure_clone();
    // 1,500 left: above sleep (1,000), still awake.
    let ix = withdraw_ix(&e, &launcher.pubkey(), &l, &l.launcher_line, 1_000 * ONE);
    ok(send(&mut e.svm, &launcher, &[], vec![ix]));
    assert!(read::<ll::AgentLaunch>(&e.svm, &l.launch).awake);
    // 900: asleep.
    let ix = withdraw_ix(&e, &launcher.pubkey(), &l, &l.launcher_line, 600 * ONE);
    ok(send(&mut e.svm, &launcher, &[], vec![ix]));
    assert!(!read::<ll::AgentLaunch>(&e.svm, &l.launch).awake);
    assert_eq!(balance(&e.svm, &l.launcher_line), 1_600 * ONE);
    // 1,800: still asleep (below wake 2,000); 2,000: awake.
    e.fund(&l.compute_vault, 900 * ONE);
    assert!(!refresh(&mut e, &l));
    e.fund(&l.compute_vault, 200 * ONE);
    assert!(refresh(&mut e, &l));
    let la: ll::AgentLaunch = read(&e.svm, &l.launch);
    assert_eq!(la.withdrawn, 1_600 * ONE);
}

#[test]
fn launch_pause() {
    let mut e = setup(LineKind::Classic);
    let l = e.launch_agent(Keypair::new(), default_launch_args());
    let (t, tl, ta) = e.trader(&l, 10_000 * ONE);
    ok(e.dbc_swap(&l, &t, &tl, &ta, true, 10_000 * ONE, 1, BUY));
    let admin = e.admin.insecure_clone();
    let args = ll::LaunchConfigArgs { paused: true, ..launch_args(&admin.pubkey(), &e.runtime.pubkey(), &e.compute_sink) };
    let dc = e.dbc_config;
    ok(send(&mut e.svm, &admin, &[], vec![set_launch_config_ix(admin.pubkey(), args, dc)]));
    rejects(e.crank_fees(&l), "Paused");
    let (launcher, _) = e.wallet(0);
    rejects(e.try_launch(&launcher, &Keypair::new(), &Keypair::new(), default_launch_args()), "Paused");
    let args = ll::LaunchConfigArgs { paused: false, ..args };
    ok(send(&mut e.svm, &admin, &[], vec![set_launch_config_ix(admin.pubkey(), args, dc)]));
    ok(e.crank_fees(&l));
}
