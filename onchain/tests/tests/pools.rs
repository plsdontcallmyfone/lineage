//! Agent pools (docs/plans/AGENT-POOLS.md) on LiteSVM against mainnet's pump.fun builds: two agents
//! on one repository form a pool, route their slices, a settlement allocates payouts, buybacks and a
//! milestone burn, the keeper's buys go through Pump and PumpSwap by CPI, and the attacks of section
//! 7: substituted crank accounts, drains through settle, pay and buy, join rules, and the feature off.
#![allow(clippy::result_large_err)]
use anchor_lang::solana_program::instruction::AccountMeta;
use units_onchain_tests::*;

struct Fx {
    e: Env,
    keeper: Keypair,
}

const CROSS: u64 = ONE / 10;

fn cfg(keeper: &Pubkey) -> ll::PoolConfigArgs {
    ll::PoolConfigArgs { cross_hold_quote: CROSS, ..pool_args(keeper) }
}

fn fx() -> Fx {
    let mut e = setup(LineKind::PumpCoin);
    let keeper = funded(&mut e.svm);
    let admin = e.admin.insecure_clone();
    let ix = e.set_pool_config_ix(&admin.pubkey(), cfg(&keeper.pubkey()));
    ok(send(&mut e.svm, &admin, &[], vec![ix]));
    e.set_features(ll::FEATURE_POOLS);
    Fx { e, keeper }
}

fn other_repo() -> ll::PumpLaunchArgs {
    ll::PumpLaunchArgs { repo_url: "https://github.com/lineage-test/other".into(), ..default_launch_args() }
}

impl Fx {
    fn set_cfg(&mut self, f: impl FnOnce(&mut ll::PoolConfigArgs)) {
        let admin = self.e.admin.insecure_clone();
        let mut a = cfg(&self.keeper.pubkey());
        f(&mut a);
        let ix = self.e.set_pool_config_ix(&admin.pubkey(), a);
        ok(send(&mut self.e.svm, &admin, &[], vec![ix]));
    }
    fn join(&mut self, l: &Launched, existing: &[&Launched]) -> litesvm::types::TransactionResult {
        let repo = repo_of(&self.e.svm, l);
        let ex: Vec<Pubkey> = existing.iter().map(|m| m.agent.pubkey()).collect();
        let ix = self.e.join_ix(&l.launcher.pubkey(), l, &repo, &ex);
        send(&mut self.e.svm, &l.launcher, &[], vec![cu(400_000), ix])
    }
    /// Two agents launched on the same repository and joined; the pool authority funded with SOL
    /// and holding a token account for each member mint.
    fn pair(&mut self) -> (Launched, Launched, [u8; 32]) {
        let a = self.e.launch_agent(Keypair::new(), default_launch_args());
        let b = self.e.launch_agent(Keypair::new(), default_launch_args());
        ok(self.join(&a, &[]));
        ok(self.join(&b, &[&a]));
        let repo = repo_of(&self.e.svm, &a);
        let auth = pool_auth(&repo);
        self.e.svm.airdrop(&auth, 1_000_000_000).unwrap();
        let k = self.keeper.insecure_clone();
        ok(send(&mut self.e.svm, &k, &[], vec![create_ata_ix(&k.pubkey(), &auth, &a.mint, &T22), create_ata_ix(&k.pubkey(), &auth, &b.mint, &T22)]));
        (a, b, repo)
    }
    fn trade(&mut self, l: &Launched) -> u64 {
        let (t, _, _) = self.e.trader(l, 50_000_000 * ONE);
        ok(self.e.curve_buy(l, &t, 100_000_000 * ONE));
        pf::curve_view(&self.e.svm, &l.mint).creator_fee
    }
    fn pool(&self, repo: &[u8; 32]) -> ll::Pool {
        read(&self.e.svm, &pool_pda(repo))
    }
    fn member(&self, l: &Launched) -> ll::PoolMember {
        read(&self.e.svm, &pool_member(&l.agent.pubkey()))
    }
    fn vault(&self, repo: &[u8; 32]) -> u64 {
        balance(&self.e.svm, &ata(&pool_auth(repo), &self.e.line_mint, &self.e.line_program))
    }
    /// Every unit in the vault is in a bucket or owed to a member.
    fn conserved(&self, repo: &[u8; 32], members: &[&Launched]) {
        let p = self.pool(repo);
        let owed: u64 = members.iter().map(|l| { let m = self.member(l); m.cross_funded + m.payout_due + m.buyback_due + m.burn_due }).sum();
        assert_eq!(self.vault(repo), p.bucket_payout + p.bucket_buyback + p.bucket_burn + owed, "vault = buckets + dues");
    }
    fn settle(&mut self, repo: &[u8; 32], members: &[&Launched], epoch: u64, gens: u16, weights: Vec<u16>, milestones: u8) -> litesvm::types::TransactionResult {
        let k = self.keeper.insecure_clone();
        let ms: Vec<Pubkey> = members.iter().map(|m| m.agent.pubkey()).collect();
        let ix = self.e.settle_ix(&k.pubkey(), repo, &ms, ll::PoolSettleArgs { epoch, gens, weights, milestones, evidence: [9; 32] });
        send(&mut self.e.svm, &k, &[], vec![ix])
    }
    /// Tokens of `l` that cost a little under `quote` on its curve (fees included).
    fn tokens_for(&self, l: &Launched, quote: u64) -> u64 {
        let c = pf::curve_view(&self.e.svm, &l.mint);
        let net = quote as u128 * 96 / 100;
        (net * c.virtual_token as u128 / (c.virtual_quote as u128 + net)) as u64
    }
    fn buy(&mut self, repo: &[u8; 32], target: &Launched, kind: u8, token_amount: u64, max_quote: u64) -> litesvm::types::TransactionResult {
        let k = self.keeper.insecure_clone();
        let ix = self.e.pool_buy_ix(&k.pubkey(), repo, target, kind, ll::PoolBuyArgs { venue: ll::VENUE_CURVE, token_amount, max_quote });
        send_unchecked(&mut self.e.svm, &k, &[], vec![cu(800_000), ix])
    }
    fn cross(&mut self, repo: &[u8; 32], holder: &Launched, target: &Launched, token_amount: u64) -> litesvm::types::TransactionResult {
        let k = self.keeper.insecure_clone();
        let ix = self.e.cross_buy_ix(&k.pubkey(), repo, holder, target, ll::PoolBuyArgs { venue: ll::VENUE_CURVE, token_amount, max_quote: u64::MAX });
        // the holder agent's own token account of the target's mint (anyone may create it)
        let holder_ata = create_ata_ix(&k.pubkey(), &holder.agent.pubkey(), &target.mint, &T22);
        send_unchecked(&mut self.e.svm, &k, &[], vec![cu(800_000), holder_ata, ix])
    }
    /// A pool with both members' slices routed and epoch 1 settled: one generation by A, one milestone.
    fn settled(&mut self) -> (Launched, Launched, [u8; 32]) {
        let (a, b, repo) = self.pair();
        self.trade(&a);
        self.trade(&b);
        ok(self.e.crank_routed(&a));
        ok(self.e.crank_routed(&b));
        self.e.post_empty_epoch(1);
        ok(self.settle(&repo, &[&a, &b], 1, 1, vec![10_000, 0], 1));
        (a, b, repo)
    }
}

fn bps(x: u64, b: u64) -> u64 {
    (x as u128 * b as u128 / 10_000) as u64
}

#[test]
fn two_agents_on_one_repository_pool_fees_pay_buy_and_burn() {
    let mut f = fx();
    let a = f.e.launch_agent(Keypair::new(), default_launch_args());
    let b = f.e.launch_agent(Keypair::new(), default_launch_args());
    ok(f.join(&a, &[]));
    let repo = repo_of(&f.e.svm, &a);
    assert_eq!(read::<ll::AgentLaunch>(&f.e.svm, &a.launch).routes, ll::ROUTE_POOL);
    // A pool of one routes nothing: today's split, with the member's accounts attached.
    let fees = f.trade(&a);
    let (tr0, cv0) = (balance(&f.e.svm, &treasury()), balance(&f.e.svm, &a.compute_vault));
    ok(f.e.crank_routed(&a));
    let agent_share = bps(fees, 7000);
    assert_eq!((balance(&f.e.svm, &a.compute_vault) - cv0, balance(&f.e.svm, &treasury()) - tr0, f.vault(&repo)), (agent_share, fees - agent_share, 0));
    // The second agent joins: each owes one purchase of the other's token.
    ok(f.join(&b, &[&a]));
    let p = f.pool(&repo);
    assert_eq!(p.members, vec![a.agent.pubkey(), b.agent.pubkey()]);
    for l in [&a, &b] {
        let m = f.member(l);
        assert_eq!((m.pool, m.mint, m.cross_pairs, m.cross_due), (pool_pda(&repo), l.mint, 1, CROSS));
    }
    let auth = pool_auth(&repo);
    f.e.svm.airdrop(&auth, 1_000_000_000).unwrap();
    let k = f.keeper.insecure_clone();
    ok(send(&mut f.e.svm, &k, &[], vec![create_ata_ix(&k.pubkey(), &auth, &a.mint, &T22), create_ata_ix(&k.pubkey(), &auth, &b.mint, &T22)]));
    // Both trade; each crank routes pool_fee_bps of the agent share, protocol share untouched.
    let mut cuts = vec![];
    for l in [&a, &b] {
        f.trade(l);
        let fees = pf::curve_view(&f.e.svm, &l.mint).creator_fee;
        let (tr0, cv0, v0) = (balance(&f.e.svm, &treasury()), balance(&f.e.svm, &l.compute_vault), f.vault(&repo));
        ok(f.e.crank_routed(l));
        let agent_share = bps(fees, 7000);
        let cut = bps(agent_share, 2000);
        assert!(cut > CROSS, "the slice funds the cross-holding and more ({cut})");
        assert_eq!(balance(&f.e.svm, &treasury()) - tr0, fees - agent_share, "protocol share unchanged by the pool");
        assert_eq!(balance(&f.e.svm, &l.compute_vault) - cv0, agent_share - cut);
        assert_eq!(f.vault(&repo) - v0, cut);
        let m = f.member(l);
        assert_eq!((m.contributed, m.cross_due, m.cross_funded), (cut, 0, CROSS));
        cuts.push(cut - CROSS);
    }
    let p = f.pool(&repo);
    let payout: u64 = cuts.iter().map(|c| bps(*c, 4000)).sum();
    let buyback: u64 = cuts.iter().map(|c| bps(*c, 4000)).sum();
    let burn: u64 = cuts.iter().map(|c| c - bps(*c, 4000) - bps(*c, 4000)).sum();
    assert_eq!((p.bucket_payout, p.bucket_buyback, p.bucket_burn), (payout, buyback, burn));
    f.conserved(&repo, &[&a, &b]);
    // Epoch 1: one verified generation, all of it A's; one milestone.
    f.e.post_empty_epoch(1);
    ok(f.settle(&repo, &[&a, &b], 1, 1, vec![10_000, 0], 1));
    let budget = bps(buyback, 2500);
    let own = bps(budget, 2000);
    let burn_each = bps(burn, 5000) / 2;
    let (ma, mb) = (f.member(&a), f.member(&b));
    assert_eq!((ma.payout_due, ma.buyback_due, ma.burn_due), (payout, own, burn_each), "the author: the whole payout, the smaller buyback part");
    assert_eq!((mb.payout_due, mb.buyback_due, mb.burn_due), (0, budget - own, burn_each), "the other member: the larger buyback part");
    let p = f.pool(&repo);
    assert_eq!((p.bucket_payout, p.bucket_buyback, p.bucket_burn), (0, buyback - budget, burn - 2 * burn_each));
    assert_eq!((p.last_epoch, p.gens, p.milestones), (1, 1, 1));
    f.conserved(&repo, &[&a, &b]);
    // (i) payout into the author's compute vault, by anyone.
    let anyone = funded(&mut f.e.svm);
    let cv0 = balance(&f.e.svm, &a.compute_vault);
    let (pay_a, pay_b) = (f.e.pay_ix(&repo, &a), f.e.pay_ix(&repo, &b));
    ok(send(&mut f.e.svm, &anyone, &[], vec![pay_a.clone()]));
    assert_eq!(balance(&f.e.svm, &a.compute_vault) - cv0, payout);
    rejects(send(&mut f.e.svm, &anyone, &[], vec![pay_a]), "NothingToClaim");
    rejects(send(&mut f.e.svm, &anyone, &[], vec![pay_b]), "NothingToClaim");
    // (iv) cross-holdings: A buys B's token, B buys A's, each once, from its own funded slice.
    for (h, t) in [(&a, &b), (&b, &a)] {
        let tokens = f.tokens_for(t, CROSS);
        let v0 = f.vault(&repo);
        ok(f.cross(&repo, h, t, tokens));
        let c: ll::CrossHolding = read(&f.e.svm, &cross_pda(&h.agent.pubkey(), &t.agent.pubkey()));
        assert_eq!((c.holder, c.target, c.tokens, c.quote_spent), (h.agent.pubkey(), t.agent.pubkey(), tokens, v0 - f.vault(&repo)));
        assert!(c.quote_spent > 0 && c.quote_spent <= CROSS);
        assert_eq!(balance(&f.e.svm, &ata(&h.agent.pubkey(), &t.mint, &T22)), tokens, "delivered to the holder agent's own account");
        assert_eq!(balance(&f.e.svm, &ata(&auth, &t.mint, &T22)), 0, "nothing of a cross-holding stays with the pool");
        let mh = f.member(h);
        assert_eq!((mh.cross_pairs, mh.cross_funded), (0, 0), "what the purchase did not use went to the buyback bucket");
        rejects(f.cross(&repo, h, t, 1), "already in use");
    }
    f.conserved(&repo, &[&a, &b]);
    // (ii) buyback of B's token (the non-author): held by the pool.
    let due = f.member(&b).buyback_due;
    let tokens = f.tokens_for(&b, due);
    let (v0, held0) = (f.vault(&repo), f.member(&b).tokens_held);
    ok(f.buy(&repo, &b, ll::BUY_BUYBACK, tokens, u64::MAX));
    let spent = v0 - f.vault(&repo);
    let mb = f.member(&b);
    assert!(spent > 0 && spent <= due);
    assert_eq!((mb.buyback_due, mb.tokens_held - held0), (due - spent, tokens));
    assert_eq!(balance(&f.e.svm, &ata(&auth, &b.mint, &T22)), mb.tokens_held);
    // (iii) milestone burn of A's token: bought and burned in one instruction.
    let due = f.member(&a).burn_due;
    let tokens = f.tokens_for(&a, due);
    let (v0, supply0, held0) = (f.vault(&repo), supply(&f.e.svm, &a.mint), balance(&f.e.svm, &ata(&auth, &a.mint, &T22)));
    ok(f.buy(&repo, &a, ll::BUY_BURN, tokens, u64::MAX));
    let ma = f.member(&a);
    assert_eq!(supply0 - supply(&f.e.svm, &a.mint), tokens, "supply fell by the tokens bought");
    assert_eq!(balance(&f.e.svm, &ata(&auth, &a.mint, &T22)), held0, "nothing of the burn purchase stays");
    assert_eq!((ma.tokens_burned, ma.burn_due), (tokens, due - (v0 - f.vault(&repo))));
    f.conserved(&repo, &[&a, &b]);
}

#[test]
fn feature_off_is_the_split_of_today() {
    let mut f = fx();
    let (a, b, repo) = f.pair();
    let c = f.e.launch_agent(Keypair::new(), default_launch_args());
    f.trade(&a);
    // On: a member's crank needs its pool accounts; a non-member's does not.
    rejects(f.e.crank_fees(&a), "MissingRouteAccounts");
    f.trade(&c);
    ok(f.e.crank_fees(&c));
    // Off: the member's eight-account crank pays today's two amounts, to the unit, and nothing else moves.
    f.e.set_features(0);
    let fees = pf::curve_view(&f.e.svm, &a.mint).creator_fee;
    let (tr0, cv0) = (balance(&f.e.svm, &treasury()), balance(&f.e.svm, &a.compute_vault));
    ok(f.e.crank_fees(&a));
    let to_compute = bps(fees, 7000);
    assert_eq!((balance(&f.e.svm, &a.compute_vault) - cv0, balance(&f.e.svm, &treasury()) - tr0), (to_compute, fees - to_compute));
    assert_eq!((f.vault(&repo), balance(&f.e.svm, &a.creator_line_token)), (0, 0));
    // Every pool instruction is refused while off.
    rejects(f.join(&c, &[&a, &b]), "FeatureOff");
    f.e.post_empty_epoch(1);
    rejects(f.settle(&repo, &[&a, &b], 1, 0, vec![0, 0], 0), "FeatureOff");
    rejects(f.buy(&repo, &a, ll::BUY_BUYBACK, 1, 1), "FeatureOff");
    rejects(f.cross(&repo, &a, &b, 1), "FeatureOff");
    // Paused (feature on): the crank routes nothing and still needs no more than its accounts.
    f.e.set_features(ll::FEATURE_POOLS);
    f.set_cfg(|c| c.paused = true);
    f.trade(&a);
    let fees = pf::curve_view(&f.e.svm, &a.mint).creator_fee;
    let cv0 = balance(&f.e.svm, &a.compute_vault);
    ok(f.e.crank_routed(&a));
    assert_eq!((balance(&f.e.svm, &a.compute_vault) - cv0, f.vault(&repo)), (bps(fees, 7000), 0));
    rejects(f.join(&c, &[&a, &b]), "Paused");
    // Config: admin only, bounded.
    let admin = f.e.admin.insecure_clone();
    let stranger = funded(&mut f.e.svm);
    let ix = f.e.set_pool_config_ix(&stranger.pubkey(), cfg(&stranger.pubkey()));
    rejects(send(&mut f.e.svm, &stranger, &[], vec![ix]), "Unauthorized");
    for bad in [ll::PoolConfigArgs { pool_fee_bps: 5001, ..cfg(&admin.pubkey()) }, ll::PoolConfigArgs { burn_bps: 2001, ..cfg(&admin.pubkey()) },
        ll::PoolConfigArgs { max_members: 17, ..cfg(&admin.pubkey()) }, ll::PoolConfigArgs { keeper: Pubkey::default(), ..cfg(&admin.pubkey()) },
        ll::PoolConfigArgs { author_buyback_bps: 10_001, ..cfg(&admin.pubkey()) }] {
        let ix = f.e.set_pool_config_ix(&admin.pubkey(), bad);
        rejects(send(&mut f.e.svm, &admin, &[], vec![ix]), "InvalidArgs");
    }
}

#[test]
fn join_rules() {
    let mut f = fx();
    let a = f.e.launch_agent(Keypair::new(), default_launch_args());
    let b = f.e.launch_agent(Keypair::new(), default_launch_args());
    let x = f.e.launch_agent(Keypair::new(), other_repo());
    let repo = repo_of(&f.e.svm, &a);
    let xrepo = repo_of(&f.e.svm, &x);
    assert_ne!(repo, xrepo);
    // Opt-in: only the agent's registry owner.
    let stranger = funded(&mut f.e.svm);
    let ix = f.e.join_ix(&stranger.pubkey(), &a, &repo, &[]);
    rejects(send(&mut f.e.svm, &stranger, &[], vec![cu(400_000), ix]), "Unauthorized");
    ok(f.join(&a, &[]));
    rejects(f.join(&a, &[&a]), "already in use");
    // An agent of another repository cannot enter this pool: the pool is derived from its own launch.
    let ix = f.e.join_ix(&x.launcher.pubkey(), &x, &repo, &[a.agent.pubkey()]);
    rejects(send(&mut f.e.svm, &x.launcher, &[], vec![cu(400_000), ix]), "ConstraintSeeds");
    // The existing members' accounts must all be there, in order, and be theirs.
    rejects(f.join(&b, &[]), "MissingRouteAccounts");
    ok(f.join(&x, &[]));
    let ix = f.e.join_ix(&b.launcher.pubkey(), &b, &repo, &[x.agent.pubkey()]);
    rejects(send(&mut f.e.svm, &b.launcher, &[], vec![cu(400_000), ix]), "WrongPoolAccount");
    // Full.
    f.set_cfg(|c| c.max_members = 2);
    ok(f.join(&b, &[&a]));
    let c = f.e.launch_agent(Keypair::new(), default_launch_args());
    rejects(f.join(&c, &[&a, &b]), "PoolFull");
    // Auto-join: anyone may join a launched agent to the pool of its repository.
    f.set_cfg(|c| c.auto_join = true);
    let ix = f.e.join_ix(&stranger.pubkey(), &c, &repo, &[a.agent.pubkey(), b.agent.pubkey()]);
    ok(send(&mut f.e.svm, &stranger, &[], vec![cu(400_000), ix]));
    let p = f.pool(&repo);
    assert_eq!(p.members.len(), 3);
    assert_eq!((f.member(&a).cross_pairs, f.member(&b).cross_pairs, f.member(&c).cross_pairs), (2, 2, 2));
    assert_eq!(f.member(&c).cross_due, 2 * CROSS);
}

#[test]
fn the_crank_refuses_substituted_pool_accounts() {
    let mut f = fx();
    let (a, _b, repo) = f.pair();
    let x = f.e.launch_agent(Keypair::new(), other_repo());
    let y = f.e.launch_agent(Keypair::new(), other_repo());
    ok(f.join(&x, &[]));
    ok(f.join(&y, &[&x]));
    let xrepo = repo_of(&f.e.svm, &x);
    f.trade(&a);
    let k = funded(&mut f.e.svm);
    let line = f.e.line_mint;
    ok(send(&mut f.e.svm, &k, &[], vec![cu(600_000), create_ata_ix(&k.pubkey(), &a.pump_creator, &line, &f.e.line_program),
        pf::sweep_creator_fee_ix(&k.pubkey(), &a.mint, &line, &a.pump_creator), pf::collect_creator_fee_v2_ix(&a.pump_creator, &line)]));
    let (_thief, thief_token) = f.e.wallet(0);
    let honest = f.e.route_metas(&a);
    assert_eq!(honest.len(), 4);
    let attempt = |f: &mut Fx, i: usize, key: Pubkey, why: &str| {
        let mut ix = f.e.crank_ix(&a);
        let mut m = honest.clone();
        m[i] = AccountMeta::new(key, false);
        ix.accounts.extend(m);
        rejects(send(&mut f.e.svm, &k, &[], vec![ix]), why);
    };
    // Another agent's membership, another repository's pool, its vault, the caller's own token account.
    attempt(&mut f, 1, pool_member(&x.agent.pubkey()), "WrongPoolAccount");
    attempt(&mut f, 2, pool_pda(&xrepo), "WrongPoolAccount");
    let xvault = ata(&pool_auth(&xrepo), &line, &f.e.line_program);
    attempt(&mut f, 3, xvault, "WrongPoolAccount");
    attempt(&mut f, 3, thief_token, "WrongPoolAccount");
    // A look-alike config owned by another program (zero fee, to keep the slice for compute).
    let fake = Pubkey::new_unique();
    let mut acct = f.e.svm.get_account(&pool_config()).unwrap();
    acct.owner = lr::ID;
    f.e.svm.set_account(fake, acct).unwrap();
    attempt(&mut f, 0, fake, "AccountOwnedByWrongProgram");
    let mut ix = f.e.crank_ix(&a);
    ix.accounts.extend(honest[..3].to_vec());
    rejects(send(&mut f.e.svm, &k, &[], vec![ix]), "MissingRouteAccounts");
    let mut ix = f.e.crank_ix(&a);
    ix.accounts.extend(honest.clone());
    ok(send(&mut f.e.svm, &k, &[], vec![ix]));
    assert!(f.vault(&repo) > 0);
    assert_eq!((f.vault(&xrepo), balance(&f.e.svm, &thief_token)), (0, 0));
}

#[test]
fn settlements_are_the_keepers_once_per_posted_epoch() {
    let mut f = fx();
    let (a, b, repo) = f.pair();
    f.trade(&a);
    ok(f.e.crank_routed(&a));
    // No epoch posted yet.
    rejects(f.settle(&repo, &[&a, &b], 1, 1, vec![5000, 5000], 0), "PoolEpoch");
    f.e.post_empty_epoch(1);
    // A stranger; the admin is not the keeper either.
    let stranger = funded(&mut f.e.svm);
    let args = ll::PoolSettleArgs { epoch: 1, gens: 1, weights: vec![5000, 5000], milestones: 0, evidence: [0; 32] };
    let ix = f.e.settle_ix(&stranger.pubkey(), &repo, &[a.agent.pubkey(), b.agent.pubkey()], args.clone());
    rejects(send(&mut f.e.svm, &stranger, &[], vec![ix]), "Unauthorized");
    let admin = f.e.admin.insecure_clone();
    let ix = f.e.settle_ix(&admin.pubkey(), &repo, &[a.agent.pubkey(), b.agent.pubkey()], args);
    rejects(send(&mut f.e.svm, &admin, &[], vec![ix]), "Unauthorized");
    // An epoch the registry has not posted; weights that do not sum, of the wrong length, or without generations.
    rejects(f.settle(&repo, &[&a, &b], 2, 1, vec![5000, 5000], 0), "PoolEpoch");
    rejects(f.settle(&repo, &[&a, &b], 1, 1, vec![5000, 5001], 0), "PoolWeights");
    rejects(f.settle(&repo, &[&a, &b], 1, 1, vec![9000, 999], 0), "PoolWeights");
    rejects(f.settle(&repo, &[&a, &b], 1, 0, vec![5000, 5000], 0), "PoolWeights");
    rejects(f.settle(&repo, &[&a, &b], 1, 1, vec![10_000], 0), "InvalidArgs");
    rejects(f.settle(&repo, &[&a, &b], 1, 0, vec![0, 0], 17), "InvalidArgs");
    // Members' accounts swapped or missing.
    rejects(f.settle(&repo, &[&b, &a], 1, 1, vec![5000, 5000], 0), "WrongPoolAccount");
    rejects(f.settle(&repo, &[&a], 1, 1, vec![5000, 5000], 0), "MissingRouteAccounts");
    // An epoch without verified improvement moves nothing and still counts as settled.
    let before = f.pool(&repo);
    ok(f.settle(&repo, &[&a, &b], 1, 0, vec![0, 0], 0));
    let after = f.pool(&repo);
    assert_eq!((after.bucket_payout, after.bucket_buyback, after.bucket_burn), (before.bucket_payout, before.bucket_buyback, before.bucket_burn));
    // The same epoch again, with generations this time: refused, so one epoch cannot be paid twice.
    rejects(f.settle(&repo, &[&a, &b], 1, 1, vec![5000, 5000], 1), "PoolEpoch");
    warp(&mut f.e.svm, 400);
    f.e.post_empty_epoch(2);
    ok(f.settle(&repo, &[&a, &b], 2, 4, vec![2500, 7500], 2));
    // gens x buyback_per_gen_bps and milestones x burn_per_milestone_bps are capped at the whole bucket.
    let p = f.pool(&repo);
    assert_eq!(p.bucket_payout, before.bucket_payout - bps(before.bucket_payout, 2500) - bps(before.bucket_payout, 7500));
    assert!(p.bucket_buyback <= 3 && p.bucket_burn <= 1, "rounding dust only: {} {}", p.bucket_buyback, p.bucket_burn);
    f.conserved(&repo, &[&a, &b]);
    rejects(f.settle(&repo, &[&a, &b], 2, 1, vec![5000, 5000], 0), "PoolEpoch");
    rejects(f.settle(&repo, &[&a, &b], 1, 1, vec![5000, 5000], 0), "PoolEpoch");
}

#[test]
fn pool_funds_cannot_be_drained_through_pay_or_buy() {
    let mut f = fx();
    let (a, b, repo) = f.settled();
    let auth = pool_auth(&repo);
    let x = f.e.launch_agent(Keypair::new(), other_repo());
    let k = f.keeper.insecure_clone();
    ok(send(&mut f.e.svm, &k, &[], vec![create_ata_ix(&k.pubkey(), &auth, &x.mint, &T22)]));
    let stranger = funded(&mut f.e.svm);
    let v0 = f.vault(&repo);
    let due = f.member(&b).buyback_due;
    let tokens = f.tokens_for(&b, due);
    let args = ll::PoolBuyArgs { venue: ll::VENUE_CURVE, token_amount: tokens, max_quote: u64::MAX };
    // Not the keeper.
    let ix = f.e.pool_buy_ix(&stranger.pubkey(), &repo, &b, ll::BUY_BUYBACK, args);
    rejects(send_unchecked(&mut f.e.svm, &stranger, &[], vec![cu(800_000), ix]), "Unauthorized");
    // A payout to another agent's compute vault, or another agent's launch record.
    let mut ix = f.e.pay_ix(&repo, &a);
    ix.accounts[6] = AccountMeta::new(b.compute_vault, false);
    rejects(send(&mut f.e.svm, &stranger, &[], vec![ix]), "ConstraintSeeds");
    let mut ix = f.e.pay_ix(&repo, &a);
    ix.accounts[5] = AccountMeta::new(x.launch, false);
    rejects(send(&mut f.e.svm, &stranger, &[], vec![ix]), "ConstraintSeeds");
    // A mint that is not a member's: no PoolMember exists for it, and a member's record with another mint is refused.
    let mut ix = f.e.pool_buy_ix(&k.pubkey(), &repo, &b, ll::BUY_BUYBACK, args);
    ix.accounts[7] = AccountMeta::new(x.mint, false);
    ix.accounts[8] = AccountMeta::new(ata(&auth, &x.mint, &T22), false);
    rejects(send_unchecked(&mut f.e.svm, &k, &[], vec![cu(800_000), ix]), "WrongPoolAccount");
    // The right target, but the venue accounts buy another coin: the pool's token account gains nothing.
    let mut ix = f.e.pool_buy_ix(&k.pubkey(), &repo, &b, ll::BUY_BUYBACK, args);
    ix.accounts.truncate(11);
    ix.accounts.extend(curve_buy_metas(&x.mint, &f.e.line_mint, &f.e.line_program, &auth));
    rejects(send_unchecked(&mut f.e.svm, &k, &[], vec![cu(800_000), ix]), "PoolBuyShort");
    // The venue accounts deliver to the keeper instead of the pool: the keeper is no signer inside the call.
    let mut ix = f.e.pool_buy_ix(&k.pubkey(), &repo, &b, ll::BUY_BUYBACK, args);
    ix.accounts.truncate(11);
    ix.accounts.extend(curve_buy_metas(&b.mint, &f.e.line_mint, &f.e.line_program, &k.pubkey()));
    assert!(send_unchecked(&mut f.e.svm, &k, &[], vec![cu(800_000), ix]).is_err());
    // A look-alike venue program.
    let mut ix = f.e.pool_buy_ix(&k.pubkey(), &repo, &b, ll::BUY_BUYBACK, args);
    ix.accounts[10] = AccountMeta::new_readonly(lr::ID, false);
    rejects(send_unchecked(&mut f.e.svm, &k, &[], vec![cu(800_000), ix]), "WrongVenue");
    let mut ix = f.e.pool_buy_ix(&k.pubkey(), &repo, &b, ll::BUY_BUYBACK, ll::PoolBuyArgs { venue: 7, ..args });
    ix.accounts[10] = AccountMeta::new_readonly(pf::PUMP, false);
    rejects(send_unchecked(&mut f.e.svm, &k, &[], vec![cu(800_000), ix]), "InvalidArgs");
    // More tokens than the budget buys: the venue refuses the cost, nothing moves.
    assert!(f.buy(&repo, &b, ll::BUY_BUYBACK, tokens * 3, u64::MAX).is_err());
    // No budget of that kind (A has no payout-less buy kind 3; B has no payout) and an unknown kind.
    rejects(f.buy(&repo, &b, 3, tokens, u64::MAX), "InvalidArgs");
    rejects(f.buy(&repo, &b, ll::BUY_BUYBACK, 0, u64::MAX), "PoolBudget");
    rejects(f.buy(&repo, &b, ll::BUY_BUYBACK, tokens, 0), "PoolBudget");
    // max_buy_quote bounds one buy below the due amount.
    f.set_cfg(|c| c.max_buy_quote = due / 4);
    assert!(f.buy(&repo, &b, ll::BUY_BUYBACK, tokens, u64::MAX).is_err());
    let small = f.tokens_for(&b, due / 4);
    ok(f.buy(&repo, &b, ll::BUY_BUYBACK, small, u64::MAX));
    assert!(v0 - f.vault(&repo) <= due / 4);
    f.set_cfg(|_| {});
    // A cross-holding delivered to someone else's token account (the keeper's own).
    let mut ix = f.e.cross_buy_ix(&k.pubkey(), &repo, &a, &b, ll::PoolBuyArgs { venue: ll::VENUE_CURVE, token_amount: 1, max_quote: u64::MAX });
    let mine = ata(&k.pubkey(), &b.mint, &T22);
    let at = ix.accounts.iter().position(|m| m.pubkey == ata(&a.agent.pubkey(), &b.mint, &T22)).unwrap();
    ix.accounts[at] = AccountMeta::new(mine, false);
    rejects(send_unchecked(&mut f.e.svm, &k, &[], vec![cu(800_000), create_ata_ix(&k.pubkey(), &k.pubkey(), &b.mint, &T22), ix]), "WrongPoolAccount");
    // A cross-holding of oneself, and a pair across pools.
    rejects(f.cross(&repo, &a, &a, 1), "PoolBudget");
    let y = f.e.launch_agent(Keypair::new(), other_repo());
    ok(f.join(&x, &[]));
    ok(f.join(&y, &[&x]));
    let ix = f.e.cross_buy_ix(&k.pubkey(), &repo, &a, &x, ll::PoolBuyArgs { venue: ll::VENUE_CURVE, token_amount: 1, max_quote: u64::MAX });
    rejects(send_unchecked(&mut f.e.svm, &k, &[], vec![cu(800_000), create_ata_ix(&k.pubkey(), &a.agent.pubkey(), &x.mint, &T22), ix]), "WrongPoolAccount");
    // A cross-holding before the holder's slice funded it.
    let xrepo = repo_of(&f.e.svm, &x);
    f.e.svm.airdrop(&pool_auth(&xrepo), 1_000_000_000).unwrap();
    ok(send(&mut f.e.svm, &k, &[], vec![create_ata_ix(&k.pubkey(), &pool_auth(&xrepo), &y.mint, &T22)]));
    rejects(f.cross(&xrepo, &x, &y, 1), "PoolBudget");
    // After all of it, the first pool's accounting still balances and the honest buys work.
    f.conserved(&repo, &[&a, &b]);
    let due = f.member(&a).burn_due;
    let t = f.tokens_for(&a, due);
    ok(f.buy(&repo, &a, ll::BUY_BURN, t, u64::MAX));
    f.conserved(&repo, &[&a, &b]);
}

#[test]
fn a_graduated_members_token_is_bought_on_pumpswap() {
    let mut f = fx();
    let (a, b, repo) = f.pair();
    // B's curve completes and migrates.
    let (t, _, _) = f.e.trader(&b, 400_000_000 * ONE);
    let c = pf::curve_view(&f.e.svm, &b.mint);
    let cap = pf::buy_cap(&f.e.svm, &b.mint, c.real_token) * 2;
    let ix = pf::buy_v3_ix(&b.mint, &f.e.line_mint, &f.e.line_program, &t.pubkey(), c.real_token + ONE, cap);
    ok(send(&mut f.e.svm, &t, &[], vec![cu(600_000), ix]));
    let k = f.keeper.insecure_clone();
    ok(send(&mut f.e.svm, &k, &[], vec![cu(800_000), pf::migrate_v2_ix(&k.pubkey(), &b.mint, &f.e.line_mint, &f.e.line_program)]));
    f.trade(&a);
    ok(f.e.crank_routed(&a));
    f.e.post_empty_epoch(1);
    ok(f.settle(&repo, &[&a, &b], 1, 1, vec![10_000, 0], 0));
    let due = f.member(&b).buyback_due;
    assert!(due > 0);
    // Price from the pool's reserves; ask for tokens worth about half the budget.
    let pool = pf::pool_of(&b.mint, &f.e.line_mint);
    let (base, quote) = (balance(&f.e.svm, &ata(&pool, &b.mint, &T22)), balance(&f.e.svm, &ata(&pool, &f.e.line_mint, &f.e.line_program)));
    let budget = due.min(cfg(&f.keeper.pubkey()).max_buy_quote);
    let net = budget as u128 * 50 / 100;
    let tokens = (net * base as u128 / (quote as u128 + net)) as u64;
    let v0 = f.vault(&repo);
    // The curve path no longer works for it.
    assert!(f.buy(&repo, &b, ll::BUY_BUYBACK, tokens, u64::MAX).is_err());
    // Not through any other PumpSwap pool: only the canonical pool of the mint quoted in $LINE.
    let mut bad = f.e.pool_buy_ix(&k.pubkey(), &repo, &b, ll::BUY_BUYBACK, ll::PoolBuyArgs { venue: ll::VENUE_AMM, token_amount: tokens, max_quote: u64::MAX });
    bad.accounts[11] = AccountMeta::new(pf::pool_of(&a.mint, &f.e.line_mint), false);
    rejects(send_unchecked(&mut f.e.svm, &k, &[], vec![cu(800_000), bad]), "PumpPoolUnexpected");
    let ix = f.e.pool_buy_ix(&k.pubkey(), &repo, &b, ll::BUY_BUYBACK, ll::PoolBuyArgs { venue: ll::VENUE_AMM, token_amount: tokens, max_quote: u64::MAX });
    ok(send_unchecked(&mut f.e.svm, &k, &[], vec![cu(800_000), ix]));
    let spent = v0 - f.vault(&repo);
    assert!(spent > 0 && spent <= budget, "{spent} of {budget}");
    let mb = f.member(&b);
    assert_eq!((mb.tokens_held, mb.buyback_due), (tokens, due - spent));
    assert_eq!(balance(&f.e.svm, &ata(&pool_auth(&repo), &b.mint, &T22)), tokens);
    f.conserved(&repo, &[&a, &b]);
}
